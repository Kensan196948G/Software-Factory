/**
 * Cloudflare Access の JWT（Cf-Access-Jwt-Assertion）を検証する。
 * DB や config に依存しない。トークンの中身はログや例外へ出さない。
 */
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';

/** 公開鍵キャッシュの有効期間。過ぎたら次の検証時に取り直す。 */
const JWKS_TTL_MS = 60 * 60_000;
/** 取得に失敗し続けても、古い鍵を使ってよい上限。過ぎたら拒否する（失効した鍵を使い続けない）。 */
const JWKS_MAX_STALE_MS = 24 * 60 * 60_000;
/** 取得の最小間隔。未知の kid を連打されても Cloudflare へ取りに行きすぎない。 */
const JWKS_REFRESH_COOLDOWN_MS = 30_000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
/** サーバ間の時計のずれの許容（秒）。exp / nbf に適用する。 */
const CLOCK_SKEW_SECONDS = 30;
const MIN_RSA_MODULUS_BITS = 2048;

export type AccessJwtRejectReason =
  | 'malformed'
  | 'unsupported_alg'
  | 'missing_kid'
  | 'unknown_kid'
  | 'bad_signature'
  | 'bad_issuer'
  | 'bad_audience'
  | 'expired'
  | 'not_yet_valid';

export type AccessJwtResult =
  | { ok: true; claims: Record<string, unknown> }
  /** reason はそのままログへ出してよい（トークンの中身を含まない）。 */
  | { ok: false; reason: AccessJwtRejectReason };

export interface AccessJwtVerifierOptions {
  /** 例: https://<team>.cloudflareaccess.com（末尾スラッシュなし）。iss と一致を確認する。 */
  teamDomain: string;
  aud: string;
  /** JWKS の取得。既定は HTTPS で取得する。テストで差し替える。 */
  fetchJwks?: (url: string) => Promise<unknown>;
  /** 現在時刻（ミリ秒）。テストで差し替える。 */
  now?: () => number;
  /** JWKS の取得失敗の通知。検証自体は例外を投げない。 */
  onJwksError?: (message: string) => void;
}

export interface AccessJwtVerifier {
  verify(token: string): Promise<AccessJwtResult>;
}

async function fetchJwksOverHttp(url: string): Promise<unknown> {
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** JWKS から、RS256 の署名検証に使える鍵だけを取り出す。 */
function parseJwks(body: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const list = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) return keys;
  for (const jwk of list as Record<string, unknown>[]) {
    if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.kid) continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
    try {
      const key = createPublicKey({ key: jwk as never, format: 'jwk' });
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) >= MIN_RSA_MODULUS_BITS) keys.set(jwk.kid, key);
    } catch {
      // 読めない鍵は使わない
    }
  }
  return keys;
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function audienceMatches(claim: unknown, expected: string): boolean {
  if (typeof claim === 'string') return claim === expected;
  return Array.isArray(claim) && claim.includes(expected);
}

export function createAccessJwtVerifier(options: AccessJwtVerifierOptions): AccessJwtVerifier {
  const { teamDomain, aud, fetchJwks = fetchJwksOverHttp, now = Date.now, onJwksError } = options;
  const certsUrl = `${teamDomain}/cdn-cgi/access/certs`;

  let cache: { keys: Map<string, KeyObject>; fetchedAt: number } | null = null;
  let lastAttemptAt: number | null = null;
  let inFlight: Promise<void> | null = null;

  /** 取得は同時に1本・最小間隔あり。失敗しても例外を投げず、以前のキャッシュを残す。 */
  function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    if (lastAttemptAt !== null && now() - lastAttemptAt < JWKS_REFRESH_COOLDOWN_MS) return Promise.resolve();
    lastAttemptAt = now();
    inFlight = (async () => {
      try {
        const keys = parseJwks(await fetchJwks(certsUrl));
        if (keys.size === 0) throw new Error('使える鍵がありません');
        cache = { keys, fetchedAt: now() };
      } catch (err) {
        onJwksError?.((err as Error).message);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function keyFor(kid: string): Promise<KeyObject | undefined> {
    if (cache && now() - cache.fetchedAt < JWKS_TTL_MS && cache.keys.has(kid)) return cache.keys.get(kid);
    await refresh();
    if (!cache || now() - cache.fetchedAt >= JWKS_MAX_STALE_MS) return undefined;
    return cache.keys.get(kid);
  }

  return {
    async verify(token) {
      const parts = token.split('.');
      if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
        // alg=none の「署名なし」トークン（末尾が空）もここで落ちる
        return { ok: false, reason: 'malformed' };
      }
      const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

      const header = decodeJsonSegment(headerPart);
      if (!header) return { ok: false, reason: 'malformed' };
      // alg はトークン側の指定に従わず RS256 に固定する（none や HS256 への差し替えを防ぐ）
      if (header.alg !== 'RS256' || header.crit !== undefined) return { ok: false, reason: 'unsupported_alg' };
      if (typeof header.kid !== 'string' || !header.kid) return { ok: false, reason: 'missing_kid' };

      const key = await keyFor(header.kid);
      if (!key) return { ok: false, reason: 'unknown_kid' };

      const signed = Buffer.from(`${headerPart}.${payloadPart}`);
      if (!verifySignature('RSA-SHA256', signed, key, Buffer.from(signaturePart, 'base64url'))) {
        return { ok: false, reason: 'bad_signature' };
      }

      // ここから先は署名済みの内容
      const claims = decodeJsonSegment(payloadPart);
      if (!claims) return { ok: false, reason: 'malformed' };
      if (claims.iss !== teamDomain) return { ok: false, reason: 'bad_issuer' };
      if (!audienceMatches(claims.aud, aud)) return { ok: false, reason: 'bad_audience' };

      const nowSeconds = now() / 1000;
      if (typeof claims.exp !== 'number' || nowSeconds >= claims.exp + CLOCK_SKEW_SECONDS) {
        return { ok: false, reason: 'expired' };
      }
      if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || nowSeconds < claims.nbf - CLOCK_SKEW_SECONDS)) {
        return { ok: false, reason: 'not_yet_valid' };
      }
      return { ok: true, claims };
    },
  };
}
