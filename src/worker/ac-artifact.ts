/**
 * CI が残す受入条件の結果（artifact `ac-results`・`msf.ac-results/v1`）の読み取り（純関数）。
 * 中身は CI が書いたものだが、大きさと形を信用しない。読めないものは証跡の欠落として扱い、合格にしない。
 * zip は依存を増やさず、中央ディレクトリを読んで1ファイルだけを展開する。
 */
import { crc32, inflateRawSync } from 'node:zlib';
import type { AcResult } from '../shared/devline.js';

export const AC_ARTIFACT_NAME = 'ac-results';
export const AC_RESULTS_SCHEMA = 'msf.ac-results/v1';
/** zip と展開後の上限。AC の結果だけなのでこれで足りる。超えたら読まない。 */
export const AC_ARTIFACT_MAX_BYTES = 1024 * 1024;
const MAX_ZIP_ENTRIES = 16;
const MAX_AC_ENTRIES = 200;
const MAX_TEST_IDS = 100;
const MAX_TEST_ID_CHARS = 300;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;

/** 証跡が無い理由。画面と stop_detail に載せる（値は載せない）。 */
export type AcArtifactProblem = 'missing' | 'expired' | 'too_large' | 'duplicate' | 'head_mismatch' | 'invalid';

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

export type AcParseResult = { ok: true; results: AcResult[] } | { ok: false; problem: 'invalid' | 'head_mismatch' };

/** `msf.ac-results/v1` を確かめる。1つでも形が合わなければ全体を読まない（部分的に信用しない）。 */
export function parseAcResults(raw: Buffer, headSha: string): AcParseResult {
  const invalid: AcParseResult = { ok: false, problem: 'invalid' };
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return invalid;
  }
  if (typeof doc !== 'object' || doc === null) return invalid;
  const { schema, headSha: reportedHead, ac } = doc as { schema?: unknown; headSha?: unknown; ac?: unknown };
  if (schema !== AC_RESULTS_SCHEMA || !Array.isArray(ac) || ac.length > MAX_AC_ENTRIES) return invalid;
  if (reportedHead !== headSha) return { ok: false, problem: 'head_mismatch' };
  const results: AcResult[] = [];
  for (const item of ac as unknown[]) {
    if (typeof item !== 'object' || item === null) return invalid;
    const { id, status, testIds } = item as { id?: unknown; status?: unknown; testIds?: unknown };
    if (typeof id !== 'string' || !AC_ID_RE.test(id)) return invalid;
    if (!AC_STATUSES.includes(status as AcResult['status'])) return invalid;
    if (!Array.isArray(testIds) || testIds.length > MAX_TEST_IDS) return invalid;
    if (!testIds.every((t) => typeof t === 'string' && t.trim() !== '' && t.length <= MAX_TEST_ID_CHARS)) return invalid;
    results.push({ acId: id, status: status as AcResult['status'], testIds: testIds as string[] });
  }
  return { ok: true, results };
}
