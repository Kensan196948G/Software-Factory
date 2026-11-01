/**
 * 差分の中身の検査（秘密の書き出しを止める）と、ログへ出す前の伏せ字。git も DB も読まない純関数。
 *
 * - 判定はバイト列から行う。git の「バイナリ」判定は作業ツリーの `.gitattributes`（AI が書ける）で変えられるので使わない。
 * - 既知の値は、そのままに加えて base64 / hex / 逆順でも探す。任意の難読化までは見つけられない（残存リスク）。
 * - 結果に値を入れない。検出器の名前と行番号だけを返す。
 */

export interface SecretPattern {
  id: string;
  re: RegExp;
}

/** パターンの一覧。`scripts/secret-scan.mjs` より広く、誤検知は人の確認（policy_violation）で扱う。 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{10,}\b/ },
  { id: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{10,}\b/ },
  { id: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'connection-string', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/ },
  { id: 'authorization-header', re: /\bauthorization\s*:\s*(?:basic|bearer)\s+[A-Za-z0-9+/=._-]{16,}/i },
];

const MIN_KNOWN_LENGTH = 8;

/** 既知の値から探す形を作る。短すぎる値は誤検知になるので除く。 */
export function knownSecretForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < MIN_KNOWN_LENGTH) continue;
    const bytes = Buffer.from(secret, 'utf8');
    forms.add(secret);
    forms.add([...secret].reverse().join(''));
    forms.add(bytes.toString('hex'));
    forms.add(bytes.toString('base64').replace(/=+$/, ''));
    forms.add(bytes.toString('base64url'));
  }
  return [...forms];
}

export interface SecretFinding {
  /** 'known-secret' か SECRET_PATTERNS の id。値は入れない。 */
  detector: string;
  /** 1 始まり。行をまたぐ検出のときは null。 */
  line: number | null;
}

const MAX_FINDINGS_PER_FILE = 10;

/** 1行（または名前）に秘密らしいものがあれば検出器の名前を返す。 */
export function detectSecret(text: string, knownForms: readonly string[]): string | null {
  if (knownForms.some((form) => text.includes(form))) return 'known-secret';
  return SECRET_PATTERNS.find((p) => p.re.test(text))?.id ?? null;
}

/** 文字列の連結や折り返しで分けた既知の値を見つけるための正規化。 */
const compact = (text: string): string => text.replace(/[\s'"`+,\\]/g, '');

/**
 * 追加された行を検査する。追加行は「古い内容に同じ行が無い行」とする（git の diff 属性に左右されない）。
 * 既存の行をそのまま動かしただけのものは見ない。
 */
export function scanAddedText(newText: string, oldText: string | null, knownForms: readonly string[]): SecretFinding[] {
  const oldLines = new Set(oldText === null ? [] : oldText.split('\n'));
  const findings: SecretFinding[] = [];
  const added: string[] = [];
  newText.split('\n').forEach((line, index) => {
    if (oldLines.has(line)) return;
    added.push(line);
    const detector = detectSecret(line, knownForms);
    if (detector && findings.length < MAX_FINDINGS_PER_FILE) findings.push({ detector, line: index + 1 });
  });
  if (findings.length === 0) {
    const joined = compact(added.join(''));
    if (knownForms.some((form) => joined.includes(form))) findings.push({ detector: 'known-secret', line: null });
  }
  return findings;
}

/** バイナリか（純関数）。NUL を含むか UTF-8 として読めないものは中身を検査できないのでバイナリとする。 */
export function isBinaryContent(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/** 値そのものと、トークンらしき形を伏せる。 */
export function makeRedactor(secrets: readonly string[]): (text: string) => string {
  const known = secrets.filter((s) => s.length >= 4);
  return (text) => {
    let out = text;
    for (const secret of known) out = out.split(secret).join('[REDACTED]');
    return out
      .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{10,}\b/g, '[REDACTED]')
      .replace(/\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, '[REDACTED]')
      .replace(/(authorization\s*:\s*)(basic|bearer)\s+[A-Za-z0-9+/=._-]+/gi, '$1[REDACTED]');
  };
}
