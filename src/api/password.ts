import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

/** 管理APIで新しく設定するパスワードの下限。既存のログイン（1文字以上）は変えない。 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

/**
 * 新しく設定するパスワードの方針を検査する。問題なければ null。
 * 既存利用者のログインを妨げないよう、ログイン時ではなく作成・変更の API だけで使う。
 */
export function passwordPolicyError(password: string, email?: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `パスワードは${PASSWORD_MIN_LENGTH}文字以上にしてください`;
  if (password.length > PASSWORD_MAX_LENGTH) return `パスワードは${PASSWORD_MAX_LENGTH}文字までです`;
  if (password.trim() === '') return 'パスワードを入れてください';
  if (email && password.toLowerCase() === email.trim().toLowerCase()) {
    return 'パスワードにメールアドレスは使えません';
  }
  return null;
}

/** scrypt でパスワードをハッシュ化する（外部依存なし）。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** ハッシュを検証する。形式が違えば false。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64 as string, 'base64');
    const expected = Buffer.from(hashB64 as string, 'base64');
    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
