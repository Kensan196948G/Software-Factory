/**
 * CI が残す受入条件の結果（artifact `ac-results`・`msf.ac-results/v2`）の読み取り（純関数）。
 * 中身は CI が書いたものだが、大きさと形を信用しない。読めないものは証跡の欠落として扱い、合格にしない。
 * v2 は各結果に「依頼の識別子（受付番号または注文書のハッシュ）」と「試験のファイル」を持ち、
 * 読み取り側がこの job の依頼と、この PR で追加・変更されたファイルに属することを確かめる。
 * v1 は形が足りないので後方互換で合格にせず、未確認（legacy_schema）として扱う。
 * zip は依存を増やさず、中央ディレクトリを読んで1ファイルだけを展開する。
 */
import { crc32, inflateRawSync } from 'node:zlib';
import { acEvidenceProblem, normalizeAcTestFile } from '../shared/devline.js';
import type { AcEvidenceScope, AcResult } from '../shared/devline.js';

export const AC_ARTIFACT_NAME = 'ac-results';
export const AC_RESULTS_SCHEMA = 'msf.ac-results/v2';
/** 旧形式。読めるが、依頼と試験ファイルの対応が無いので合格には使わない。 */
export const AC_RESULTS_SCHEMA_V1 = 'msf.ac-results/v1';
/** zip と展開後の上限。AC の結果だけなのでこれで足りる。超えたら読まない。 */
export const AC_ARTIFACT_MAX_BYTES = 1024 * 1024;
const MAX_ZIP_ENTRIES = 16;
const MAX_AC_ENTRIES = 200;
const MAX_TEST_IDS = 100;
const MAX_TEST_ID_CHARS = 300;
const MAX_REQUEST_ID_CHARS = 100;
const MAX_ORDER_HASH_CHARS = 64;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;

/** 証跡が無い理由。画面と stop_detail に載せる（値は載せない）。 */
export type AcArtifactProblem =
  | 'missing'
  | 'expired'
  | 'too_large'
  /** 同じ名前の artifact が同じ試行に複数ある。 */
  | 'duplicate'
  | 'invalid'
  /** 旧形式（v1）。依頼と試験ファイルの対応が無いので合格にしない。 */
  | 'legacy_schema'
  /** 文書または一覧の head が取得元の run と違う（古い SHA）。 */
  | 'head_mismatch'
  /** 文書のリポジトリが取得元と違う。 */
  | 'repository_mismatch'
  /** 文書または一覧の run が取得元と違う（同じ名前の別 run）。 */
  | 'run_mismatch'
  /** 文書の attempt が取得元と違う（前の試行の結果）。 */
  | 'attempt_mismatch'
  /** 同じ AC ID が文書に複数ある。 */
  | 'duplicate_ac_id'
  /** 注文書に無い AC ID が文書にある。 */
  | 'unknown_ac_id'
  /** 注文書の AC ID が文書に無い。 */
  | 'missing_ac_id'
  /** 結果の依頼の識別子が、この job の依頼（受付番号・注文書のハッシュ）と合わない。 */
  | 'request_mismatch'
  /** 結果の試験ファイルが、この PR で追加・変更されたファイルに無い。 */
  | 'test_file_mismatch'
  /** PR の変更ファイル一覧を取得できない（PR が分からない・読めない・多すぎる）。合格にしない。 */
  | 'file_scope_unavailable';

/** zip の中の .json をちょうど1つ取り出す。形が合わなければ null。 */
export function readSingleJsonFromZip(zip: Buffer, maxBytes: number = AC_ARTIFACT_MAX_BYTES): Buffer | null {
  if (zip.length < EOCD_SIZE || zip.length > maxBytes) return null;
  let eocd = -1;
  for (let i = zip.length - EOCD_SIZE; i >= Math.max(0, zip.length - EOCD_SIZE - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIG && i + EOCD_SIZE + zip.readUInt16LE(i + 20) === zip.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (count === 0 || count > MAX_ZIP_ENTRIES || cdOffset + cdSize > eocd) return null;

  const jsons: { method: number; flags: number; crc: number; compressed: number; size: number; local: number }[] = [];
  let at = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > eocd || zip.readUInt32LE(at) !== CENTRAL_SIG) return null;
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    if (at + 46 + nameLen > eocd) return null;
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    if (name.endsWith('.json')) {
      jsons.push({
        flags: zip.readUInt16LE(at + 8),
        method: zip.readUInt16LE(at + 10),
        crc: zip.readUInt32LE(at + 16),
        compressed: zip.readUInt32LE(at + 20),
        size: zip.readUInt32LE(at + 24),
        local: zip.readUInt32LE(at + 42),
      });
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  const entry = jsons[0];
  if (!entry || jsons.length !== 1) return null;
  // 暗号化・未知の圧縮方式・上限超えは読まない
  if ((entry.flags & 1) !== 0 || (entry.method !== 0 && entry.method !== 8) || entry.size > maxBytes) return null;
  if (entry.local + 30 > cdOffset || zip.readUInt32LE(entry.local) !== LOCAL_SIG) return null;
  const start = entry.local + 30 + zip.readUInt16LE(entry.local + 26) + zip.readUInt16LE(entry.local + 28);
  if (start + entry.compressed > cdOffset) return null;
  const data = zip.subarray(start, start + entry.compressed);
  let content: Buffer;
  try {
    content = entry.method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch {
    return null;
  }
  if (content.length !== entry.size || crc32(content) >>> 0 !== entry.crc >>> 0) return null;
  return content;
}

const AC_ID_RE = /^AC-[1-9]\d*$/;
const AC_STATUSES: readonly AcResult['status'][] = ['passed', 'failed', 'not_run'];

/** 取得元の run・注文書・この job の PR から分かる、文書にあるべき値。 */
export interface AcResultsExpected {
  repository: string;
  runId: number;
  runAttempt: number;
  headSha: string;
  /** 注文書の AC ID。 */
  acIds: readonly string[];
  /** v2 の証跡が満たすべき範囲（依頼の識別子と、この PR の変更ファイル）。 */
  scope: AcEvidenceScope;
}

export type AcParseResult =
  /** missingAcIds は報告の無い AC。報告のある分は読むが、無い分は判定で未確認になる。 */
  | { ok: true; results: AcResult[]; missingAcIds: string[] }
  | {
      ok: false;
      problem: Extract<
        AcArtifactProblem,
        | 'invalid'
        | 'legacy_schema'
        | 'head_mismatch'
        | 'repository_mismatch'
        | 'run_mismatch'
        | 'attempt_mismatch'
        | 'duplicate_ac_id'
        | 'unknown_ac_id'
        | 'request_mismatch'
        | 'test_file_mismatch'
      >;
    };

/** Actions の環境変数から書かれるので文字列で届く。数字だけの文字列と安全な整数を認め、それ以外は形の違反。 */
function runNumberOf(value: unknown): number | null {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * `msf.ac-results/v2` を確かめる。1つでも形が合わなければ全体を読まない（部分的に信用しない）。
 * repository・runId・runAttempt・headSha がすべて取得元の run と一致するときだけ読む。
 * 各結果の依頼の識別子（受付番号か注文書のハッシュ）がこの job の依頼と一致し、
 * 試験ファイルがこの PR で追加・変更されたファイルにあるときだけ読む。
 * 旧形式 v1 は、どの依頼の・どのファイルの試験か分からないので legacy_schema（未確認）にする。
 */
export function parseAcResults(raw: Buffer, expected: AcResultsExpected): AcParseResult {
  const invalid: AcParseResult = { ok: false, problem: 'invalid' };
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return invalid;
  }
  if (typeof doc !== 'object' || doc === null) return invalid;
  const { schema, repository, runId, runAttempt, headSha: reportedHead, ac } = doc as Record<string, unknown>;
  // v1 は後方互換で合格にしない。依頼・試験ファイルの対応が無いので未確認として扱う
  if (schema === AC_RESULTS_SCHEMA_V1) return { ok: false, problem: 'legacy_schema' };
  if (schema !== AC_RESULTS_SCHEMA || !Array.isArray(ac) || ac.length > MAX_AC_ENTRIES) return invalid;
  const reportedRun = runNumberOf(runId);
  const reportedAttempt = runNumberOf(runAttempt);
  if (typeof repository !== 'string' || reportedRun === null || reportedAttempt === null) return invalid;
  if (repository !== expected.repository) return { ok: false, problem: 'repository_mismatch' };
  if (reportedRun !== expected.runId) return { ok: false, problem: 'run_mismatch' };
  if (reportedAttempt !== expected.runAttempt) return { ok: false, problem: 'attempt_mismatch' };
  if (reportedHead !== expected.headSha) return { ok: false, problem: 'head_mismatch' };
  const results: AcResult[] = [];
  for (const item of ac as unknown[]) {
    if (typeof item !== 'object' || item === null) return invalid;
    const { id, status, testIds, requestId, orderHash, testFile } = item as {
      id?: unknown;
      status?: unknown;
      testIds?: unknown;
      requestId?: unknown;
      orderHash?: unknown;
      testFile?: unknown;
    };
    if (typeof id !== 'string' || !AC_ID_RE.test(id)) return invalid;
    if (!AC_STATUSES.includes(status as AcResult['status'])) return invalid;
    if (!Array.isArray(testIds) || testIds.length > MAX_TEST_IDS) return invalid;
    if (!testIds.every((t) => typeof t === 'string' && t.trim() !== '' && t.length <= MAX_TEST_ID_CHARS)) return invalid;
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > MAX_REQUEST_ID_CHARS)) return invalid;
    if (orderHash !== undefined && (typeof orderHash !== 'string' || orderHash.length > MAX_ORDER_HASH_CHARS)) return invalid;
    // 試験ファイルは v2 で必須。形の違うパス（絶対パス・..・空）は読み取りの違反
    const normalizedFile = normalizeAcTestFile(testFile);
    if (normalizedFile === null) return invalid;
    const result: AcResult = {
      acId: id,
      status: status as AcResult['status'],
      testIds: testIds as string[],
      testFile: normalizedFile,
      ...(typeof requestId === 'string' ? { requestId } : {}),
      ...(typeof orderHash === 'string' ? { orderHash } : {}),
    };
    // この job の依頼・この PR のファイルに属さない結果は、報告全体を信用しない
    const problem = acEvidenceProblem(result, expected.scope);
    if (problem !== null) return { ok: false, problem };
    results.push(result);
  }
  const reported = results.map((r) => r.acId);
  if (new Set(reported).size !== reported.length) return { ok: false, problem: 'duplicate_ac_id' };
  if (reported.some((id) => !expected.acIds.includes(id))) return { ok: false, problem: 'unknown_ac_id' };
  return { ok: true, results, missingAcIds: expected.acIds.filter((id) => !reported.includes(id)) };
}
