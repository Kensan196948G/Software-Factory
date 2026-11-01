/**
 * CI が残した検査済みの成果物（artifact `image`・`msf.image/v1`）の取得と照合。
 * このホストではイメージを作らない。合否の根拠にした run の artifact だけを使う（別の run・fallback なし）。
 * - zip はファイルへストリームで保存する。上限を超えたら読むのをやめる（メモリに全部載せない）。
 * - 中身は CI が書いたものだが、形と大きさを信用しない。meta は repository・run・attempt・head を照合する。
 * - tar のタグは manifest.json で先に確かめる。docker load は tar のタグで既存のタグを上書きできるため。
 * - 追う先（302）へ token を送らない。
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, openSync, closeSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw, crc32 } from 'node:zlib';
import { assertApiUrlAllowed } from '../api/issue-adapter.js';
import { DEPLOY_ARTIFACT_TAG, IMAGE_ARTIFACT_NAME, IMAGE_META_SCHEMA } from '../shared/devline-release.js';

/** 止まる理由。`unavailable` だけは通信の失敗で、押し直しで取り直せる。 */
export type ImageArtifactProblem = 'missing' | 'expired' | 'too_large' | 'mismatch' | 'unavailable';

export interface ImageMeta {
  repository: string;
  runId: string;
  runAttempt: string;
  headSha: string;
  imageId: string;
  tarSha256: string;
}

export interface ImageArtifactRequest {
  repo: string;
  /** 合否の根拠にした run と試行。 */
  runId: string;
  runAttempt: number;
  headSha: string;
}

export type ImageArtifactFetch =
  | {
      ok: true;
      tarPath: string;
      imageId: string;
      runId: string;
      runAttempt: number;
      artifactId: number;
      tarSha256: string;
      cleanup: () => void;
    }
  | { ok: false; problem: ImageArtifactProblem };

export interface ImageArtifactSource {
  fetch(input: ImageArtifactRequest): Promise<ImageArtifactFetch>;
}

export interface ImageArtifactLimits {
  maxZipBytes: number;
  maxTarBytes: number;
}

export const IMAGE_ARTIFACT_LIMITS: ImageArtifactLimits = {
  maxZipBytes: 1024 * 1024 * 1024,
  maxTarBytes: 3 * 1024 * 1024 * 1024,
};
const MAX_META_BYTES = 16 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CENTRAL_DIRECTORY = 16 * 1024;
const TAR_NAME = 'image.tar';
const META_NAME = 'image-meta.json';
const ZIP32_MAX = 0xffffffff;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;

interface ArtifactFacts {
  id: number;
  name: string;
  size_in_bytes?: number;
  expired?: boolean;
  created_at?: string | null;
  workflow_run?: { id?: number; head_sha?: string } | null;
}

/** run の artifact から `image` を選ぶ（純関数）。run と head が合わないものは使わない。複数あれば止まる。 */
export function selectImageArtifact(
  artifacts: readonly ArtifactFacts[],
  expected: { runId: string; headSha: string; attemptStartedAt?: string | null },
  limits: ImageArtifactLimits = IMAGE_ARTIFACT_LIMITS,
): { ok: true; id: number } | { ok: false; problem: ImageArtifactProblem } {
  const all = artifacts.filter((a) => a.name === IMAGE_ARTIFACT_NAME);
  // 同じ run の前の試行のものは使わない（試行の開始時刻が分かるときだけ絞る。分からなければ複数として止まる）
  const startedAt = Date.parse(expected.attemptStartedAt ?? '');
  const named = Number.isNaN(startedAt) ? all : all.filter((a) => !(Date.parse(a.created_at ?? '') < startedAt));
  if (named.length === 0) return { ok: false, problem: 'missing' };
  if (named.some((a) => String(a.workflow_run?.id) !== expected.runId || a.workflow_run?.head_sha !== expected.headSha)) {
    return { ok: false, problem: 'mismatch' };
  }
  const [artifact, ...rest] = named;
  if (!artifact || rest.length > 0) return { ok: false, problem: 'mismatch' };
  if (artifact.expired === true) return { ok: false, problem: 'expired' };
  if (!Number.isSafeInteger(artifact.id)) return { ok: false, problem: 'mismatch' };
  if ((artifact.size_in_bytes ?? 0) > limits.maxZipBytes) return { ok: false, problem: 'too_large' };
  return { ok: true, id: artifact.id };
}

/** meta の形を確かめる。1つでも合わなければ読まない。 */
export function parseImageMeta(raw: Buffer): ImageMeta | null {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return null;
  }
  const d = doc as Record<string, unknown> | null;
  if (typeof d !== 'object' || d === null || d.schema !== IMAGE_META_SCHEMA) return null;
  const { repository, runId, runAttempt, headSha, imageId, tarSha256 } = d;
  if (
    typeof repository !== 'string' ||
    typeof runId !== 'string' ||
    !/^\d+$/.test(runId) ||
    typeof runAttempt !== 'string' ||
    !/^\d+$/.test(runAttempt) ||
    typeof headSha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(headSha) ||
    typeof imageId !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(imageId) ||
    typeof tarSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(tarSha256)
  ) {
    return null;
  }
  return { repository, runId, runAttempt, headSha, imageId, tarSha256 };
}

/** meta が要求（合否の根拠にした run）と一致するか。repository は完全一致（安全側）。 */
export function imageMetaMatches(meta: ImageMeta, req: ImageArtifactRequest): boolean {
  return (
    meta.repository === req.repo &&
    meta.runId === req.runId &&
    meta.runAttempt === String(req.runAttempt) &&
    meta.headSha === req.headSha
  );
}

interface ZipEntry {
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  local: number;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const got = readSync(fd, buf, 0, length, position);
  return got === length ? buf : buf.subarray(0, got);
}

/** 末尾だけを読み、中央ディレクトリから entry を取り出す。ちょうど image.tar と image-meta.json でなければ null。 */
function readZipEntries(zipPath: string): { tar: ZipEntry; meta: ZipEntry; dataEnd: number; fd: number } | null {
  const size = statSync(zipPath).size;
  if (size < EOCD_SIZE) return null;
  const fd = openSync(zipPath, 'r');
  const fail = (): null => {
    closeSync(fd);
    return null;
  };
  const tailLength = Math.min(size, EOCD_SIZE + 0xffff);
  const tailStart = size - tailLength;
  const tail = readAt(fd, tailStart, tailLength);
  let eocd = -1;
  for (let i = tail.length - EOCD_SIZE; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD_SIG && i + EOCD_SIZE + tail.readUInt16LE(i + 20) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return fail();
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  // zip64 は読まない（上限より大きい）
  if (count !== 2 || cdSize > MAX_CENTRAL_DIRECTORY || cdOffset === ZIP32_MAX || cdOffset + cdSize > tailStart + eocd)
    return fail();
  const cd = readAt(fd, cdOffset, cdSize);
  if (cd.length !== cdSize) return fail();
  const entries = new Map<string, ZipEntry>();
  let at = 0;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > cd.length || cd.readUInt32LE(at) !== CENTRAL_SIG) return fail();
    const nameLen = cd.readUInt16LE(at + 28);
    const extraLen = cd.readUInt16LE(at + 30);
    const commentLen = cd.readUInt16LE(at + 32);
    if (at + 46 + nameLen > cd.length) return fail();
    const name = cd.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const entry: ZipEntry = {
      flags: cd.readUInt16LE(at + 8),
      method: cd.readUInt16LE(at + 10),
      crc: cd.readUInt32LE(at + 16),
      compressed: cd.readUInt32LE(at + 20),
      size: cd.readUInt32LE(at + 24),
      local: cd.readUInt32LE(at + 42),
    };
    if (
      entries.has(name) ||
      (entry.flags & 1) !== 0 ||
      (entry.method !== 0 && entry.method !== 8) ||
      entry.compressed === ZIP32_MAX ||
      entry.size === ZIP32_MAX ||
      entry.local === ZIP32_MAX
    ) {
      return fail();
    }
    entries.set(name, entry);
    at += 46 + nameLen + extraLen + commentLen;
  }
  const tar = entries.get(TAR_NAME);
  const meta = entries.get(META_NAME);
  if (!tar || !meta) return fail();
  return { tar, meta, dataEnd: cdOffset, fd };
}

class TooLarge extends Error {}

/** 1 entry をファイルへ展開する。CRC を照合し、sha256 を返す。 */
async function extractEntry(
  zipPath: string,
  fd: number,
  entry: ZipEntry,
  dataEnd: number,
  outPath: string,
  maxBytes: number,
): Promise<string | null> {
  if (entry.size > maxBytes) throw new TooLarge();
  if (entry.local + 30 > dataEnd) return null;
  const header = readAt(fd, entry.local, 30);
  if (header.length !== 30 || header.readUInt32LE(0) !== LOCAL_SIG) return null;
  const start = entry.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + entry.compressed > dataEnd) return null;
  const hash = createHash('sha256');
  let written = 0;
  let crc = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      written += chunk.length;
      // 中央ディレクトリの申告を信じず、実際に展開した量で止める
      if (written > maxBytes || written > entry.size) return done(new TooLarge());
      hash.update(chunk);
      crc = crc32(chunk, crc);
      done(null, chunk);
    },
  });
  const out = createWriteStream(outPath, { flags: 'wx', mode: 0o600 });
  // 空の entry は range を読まない（createReadStream の end は含む位置で、0 バイトを表せない）
  const source =
    entry.compressed === 0 ? Readable.from([]) : createReadStream(zipPath, { start, end: start + entry.compressed - 1 });
  if (entry.method === 8) await pipeline(source, createInflateRaw(), meter, out);
  else await pipeline(source, meter, out);
  if (written !== entry.size || crc >>> 0 !== entry.crc >>> 0) return null;
  return hash.digest('hex');
}

export type ExtractResult =
  { ok: true; tarPath: string; tarSha256: string; meta: ImageMeta } | { ok: false; problem: 'mismatch' | 'too_large' };

/** zip を展開して meta と tar の sha256 を照合する（ネットワークなし）。 */
export async function extractImageArtifact(
  zipPath: string,
  outDir: string,
  limits: ImageArtifactLimits = IMAGE_ARTIFACT_LIMITS,
): Promise<ExtractResult> {
  const zip = readZipEntries(zipPath);
  if (!zip) return { ok: false, problem: 'mismatch' };
  try {
    const metaPath = join(outDir, META_NAME);
    if ((await extractEntry(zipPath, zip.fd, zip.meta, zip.dataEnd, metaPath, MAX_META_BYTES)) === null) {
      return { ok: false, problem: 'mismatch' };
    }
    const metaFd = openSync(metaPath, 'r');
    const rawMeta = readAt(metaFd, 0, statSync(metaPath).size);
    closeSync(metaFd);
    const meta = parseImageMeta(rawMeta);
    if (!meta) return { ok: false, problem: 'mismatch' };
    const tarPath = join(outDir, TAR_NAME);
    const tarSha256 = await extractEntry(zipPath, zip.fd, zip.tar, zip.dataEnd, tarPath, limits.maxTarBytes);
    if (tarSha256 === null || tarSha256 !== meta.tarSha256) return { ok: false, problem: 'mismatch' };
    return { ok: true, tarPath, tarSha256, meta };
  } catch (err) {
    if (err instanceof TooLarge) return { ok: false, problem: 'too_large' };
    return { ok: false, problem: 'mismatch' };
  } finally {
    closeSync(zip.fd);
  }
}

/**
 * tar の manifest.json を読み、タグがちょうど DEPLOY_ARTIFACT_TAG の1イメージかを確かめる。
 * ヘッダを全部読む（中身は manifest だけ読む）。読めなければ false。
 */
export function tarHasOnlyExpectedTag(tarPath: string): boolean {
  return tarImageId(tarPath) !== null;
}

const MAX_TAR_ENTRIES = 200_000;
const TAR_TAIL_CHUNK = 1024 * 1024;

/**
 * 8 進の数値欄。`docker save` の出す形（8 進の数字のあとに NUL か空白）だけを読む。
 * 先頭の NUL や base-256 は読み手で値が変わるので受けない（null）。
 */
function tarOctal(block: Buffer, offset: number, length: number): number | null {
  const text = block.subarray(offset, offset + length).toString('latin1');
  if (!/^[0-7]+[\0 ]*$/.test(text)) return null;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) ? value : null;
}

/** ヘッダの checksum（Go の reader と同じく符号なし・符号ありの両方を受ける）。 */
function tarChecksumOk(block: Buffer): boolean {
  const stored = tarOctal(block, 148, 8);
  if (stored === null) return false;
  let unsigned = 8 * 32;
  let signed = 8 * 32;
  block.forEach((b, i) => {
    if (i >= 148 && i < 156) return;
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  });
  return stored === unsigned || stored === signed;
}

/** 終端の 0 ブロックの後は 0 だけ。後ろに項目を隠せないようにする。 */
function tarTailIsZero(fd: number, from: number, size: number): boolean {
  for (let at = from; at < size; at += TAR_TAIL_CHUNK) {
    if (readAt(fd, at, Math.min(TAR_TAIL_CHUNK, size - at)).some((b) => b !== 0)) return false;
  }
  return true;
}

/**
 * docker save の OCI レイアウトの名前だけを受ける許可リスト。読み手ごとの解釈の差を追いかけず、
 * 実物の artifact（ustar、通常ファイルとディレクトリだけ）の形以外をすべて拒否する。
 * リンク、拡張ヘッダ、prefix、圧縮（先頭の名前で弾かれる）、重複した名前は通らない。
 */
const TAR_FILE_NAME = /^(manifest\.json|index\.json|oci-layout|repositories|blobs\/sha256\/[0-9a-f]{64})$/;
const TAR_DIR_NAME = /^(blobs\/|blobs\/sha256\/)$/;

function isZero(block: Buffer, from: number, to: number): boolean {
  return block.subarray(from, to).every((b) => b === 0);
}

/** tar 全体のヘッダを走査し、manifest.json の中身をちょうど1つ取り出す。許可リストの外があれば null。 */
function readOnlyManifest(fd: number, size: number): Buffer | null {
  let at = 0;
  let manifest: Buffer | null = null;
  const seen = new Set<string>();
  for (let guard = 0; guard < MAX_TAR_ENTRIES; guard += 1) {
    if (at === size) return manifest;
    if (at + 512 > size) return null;
    const header = readAt(fd, at, 512);
    if (header.length !== 512) return null;
    if (header.every((b) => b === 0)) {
      return tarTailIsZero(fd, at + 512, size) ? manifest : null;
    }
    if (header.subarray(257, 265).toString('latin1') !== 'ustar\x0000') return null;
    if (!tarChecksumOk(header)) return null;
    // linkname、prefix、その後ろの余白は使わない（STAR などの読み分けの余地を残さない）
    if (!isZero(header, 157, 257) || !isZero(header, 345, 512)) return null;
    const entrySize = tarOctal(header, 124, 12);
    if (entrySize === null) return null;
    const dataAt = at + 512;
    const nextAt = dataAt + Math.ceil(entrySize / 512) * 512;
    if (nextAt > size) return null;
    const type = String.fromCharCode(header[156] as number);
    const nameEnd = header.subarray(0, 100).indexOf(0);
    if (nameEnd <= 0 || !isZero(header, nameEnd, 100)) return null;
    const name = header.subarray(0, nameEnd).toString('latin1');
    if (seen.has(name)) return null;
    seen.add(name);
    if (type === '5') {
      if (!TAR_DIR_NAME.test(name) || entrySize !== 0) return null;
    } else if (type === '0' || type === '\0') {
      if (!TAR_FILE_NAME.test(name)) return null;
      if (name === 'manifest.json') {
        if (entrySize > MAX_MANIFEST_BYTES) return null;
        manifest = readAt(fd, dataAt, entrySize);
        if (manifest.length !== entrySize) return null;
      }
    } else {
      return null;
    }
    at = nextAt;
  }
  return null;
}

/**
 * tar の中身から host の Docker が付けるイメージ ID（config の digest）を読む。
 * CI の `imageId` は使えない: containerd store の Docker は manifest の digest を ID にするので、
 * overlay2 の host とは同じイメージでも値が違う（2026-11-01 に実物の artifact で確認）。
 * tar 自体は `tarSha256` で固定しているので、中身の config の digest を load 後の ID と照合する。
 * タグがちょうど DEPLOY_ARTIFACT_TAG の1イメージでなければ null。
 */
export function tarImageId(tarPath: string): string | null {
  const fd = openSync(tarPath, 'r');
  try {
    const raw = readOnlyManifest(fd, statSync(tarPath).size);
    if (!raw) return null;
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as {
      RepoTags?: unknown;
      Config?: unknown;
    }[];
    if (!Array.isArray(manifest) || manifest.length !== 1) return null;
    // Go の JSON はキーの大文字小文字を区別しないので、`repotags` などで別のタグを渡せる。決まったキーだけを受ける
    const keys = Object.keys((manifest[0] ?? {}) as object).sort();
    if (keys.join(',') !== 'Config,Layers,RepoTags') return null;
    const tags = manifest[0]?.RepoTags;
    if (!Array.isArray(tags) || tags.length !== 1 || tags[0] !== DEPLOY_ARTIFACT_TAG) return null;
    const config = manifest[0]?.Config;
    const hex = typeof config === 'string' ? /^(?:blobs\/sha256\/)?([0-9a-f]{64})(?:\.json)?$/.exec(config)?.[1] : null;
    return hex ? `sha256:${hex}` : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export interface ImageArtifactSourceOptions {
  apiUrl: string;
  token: string;
  nodeEnv: string;
  /** 作業場の親。大きいファイルを置くので tmpfs でないところ。既定は OS の一時領域。 */
  workDir?: string;
  limits?: ImageArtifactLimits;
  httpTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** GitHub の artifact API から取得する実装。 */
export function createImageArtifactSource(options: ImageArtifactSourceOptions): ImageArtifactSource {
  const base = assertApiUrlAllowed(options.apiUrl, options.nodeEnv).toString().replace(/\/$/, '');
  const limits = options.limits ?? IMAGE_ARTIFACT_LIMITS;
  const httpTimeoutMs = options.httpTimeoutMs ?? 30_000;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? 600_000;
  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'mirai-sf-devline',
    'x-github-api-version': '2022-11-28',
  };

  async function download(repo: string, id: number, zipPath: string): Promise<ImageArtifactProblem | null> {
    const signal = AbortSignal.timeout(downloadTimeoutMs);
    const first = await fetch(`${base}/repos/${repo}/actions/artifacts/${id}/zip`, { headers, signal, redirect: 'manual' });
    let res = first;
    if (first.status >= 300 && first.status < 400) {
      await first.body?.cancel().catch(() => undefined);
      const location = first.headers.get('location');
      if (!location) return 'mismatch';
      let target: URL;
      try {
        target = assertApiUrlAllowed(location, options.nodeEnv);
      } catch {
        return 'mismatch';
      }
      // 追う先へ token を送らない
      res = await fetch(target, { headers: { 'user-agent': 'mirai-sf-devline' }, signal, redirect: 'manual' });
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 404) return 'missing';
      if (res.status === 410) return 'expired';
      return 'unavailable';
    }
    let written = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        written += chunk.length;
        // content-length は信用しない
        if (written > limits.maxZipBytes) return done(new TooLarge());
        done(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        meter,
        createWriteStream(zipPath, { flags: 'wx', mode: 0o600 }),
      );
    } catch (err) {
      return err instanceof TooLarge ? 'too_large' : 'unavailable';
    }
    return null;
  }

  /** 再実行で同じ名前が複数あるときだけ読む。読めなければ null（複数のまま止まる）。 */
  async function attemptStarted(req: ImageArtifactRequest): Promise<string | null> {
    try {
      const res = await fetch(`${base}/repos/${req.repo}/actions/runs/${req.runId}/attempts/${req.runAttempt}`, {
        headers,
        signal: AbortSignal.timeout(httpTimeoutMs),
        redirect: 'error',
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { run_started_at?: unknown };
      return typeof body.run_started_at === 'string' ? body.run_started_at : null;
    } catch {
      return null;
    }
  }

  return {
    async fetch(req) {
      // 数値の run ID でないもの（fake CI の記録など）は GitHub の run ではない。成果物なしで止まる
      if (!REPO_RE.test(req.repo) || !/^\d+$/.test(req.runId)) return { ok: false, problem: 'missing' };
      const params = new URLSearchParams({ name: IMAGE_ARTIFACT_NAME, per_page: '100' });
      let list: { artifacts?: ArtifactFacts[] };
      try {
        const res = await fetch(`${base}/repos/${req.repo}/actions/runs/${req.runId}/artifacts?${params.toString()}`, {
          headers,
          signal: AbortSignal.timeout(httpTimeoutMs),
          redirect: 'error',
        });
        if (res.status === 404) return { ok: false, problem: 'missing' };
        if (!res.ok) return { ok: false, problem: 'unavailable' };
        list = (await res.json()) as { artifacts?: ArtifactFacts[] };
      } catch {
        return { ok: false, problem: 'unavailable' };
      }
      if (!Array.isArray(list.artifacts)) return { ok: false, problem: 'unavailable' };
      const named = list.artifacts.filter((a) => a.name === IMAGE_ARTIFACT_NAME);
      const attemptStartedAt = named.length > 1 ? await attemptStarted(req) : null;
      const selected = selectImageArtifact(list.artifacts, { ...req, attemptStartedAt }, limits);
      if (!selected.ok) return selected;

      const dir = mkdtempSync(join(options.workDir ?? tmpdir(), 'msf-image-'));
      const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
      try {
        const zipPath = join(dir, 'artifact.zip');
        const problem = await download(req.repo, selected.id, zipPath).catch((): ImageArtifactProblem => 'unavailable');
        if (problem) {
          cleanup();
          return { ok: false, problem };
        }
        const extracted = await extractImageArtifact(zipPath, dir, limits);
        rmSync(zipPath, { force: true });
        if (!extracted.ok) {
          cleanup();
          return extracted;
        }
        const hostImageId = imageMetaMatches(extracted.meta, req) ? tarImageId(extracted.tarPath) : null;
        if (!hostImageId) {
          cleanup();
          return { ok: false, problem: 'mismatch' };
        }
        return {
          ok: true,
          tarPath: extracted.tarPath,
          imageId: hostImageId,
          runId: req.runId,
          runAttempt: req.runAttempt,
          artifactId: selected.id,
          tarSha256: extracted.tarSha256,
          cleanup,
        };
      } catch (err) {
        cleanup();
        throw err;
      }
    },
  };
}
