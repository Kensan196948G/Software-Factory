/**
 * サーバ側の差分検査（Security M-3 の残り）。ランナーの自己申告を信じず、`git diff --raw` の結果だけで判定する。
 * 入力は git-workspace の差分。ここは純関数で、git も DB も読まない。
 */
import { normalizeRepoPath } from '../shared/devline.js';
import type { DiffViolation, RepoDiffPolicy, ServerDiffResult } from '../shared/devline.js';

const MODE_SYMLINK = '120000';
const MODE_SUBMODULE = '160000';

export interface RawDiffEntry {
  srcMode: string;
  dstMode: string;
  /** A / M / D / T / R / C など（類似度の数字は除く）。 */
  status: string;
  path: string;
  /** R / C の元の path。 */
  oldPath?: string;
}

/** `git diff --raw -z` の出力を読む。読めない形は例外（呼び出し側は検査の失敗にして止める）。 */
export function parseRawDiff(output: string): RawDiffEntry[] {
  const fields = output.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  const entries: RawDiffEntry[] = [];
  for (let i = 0; i < fields.length;) {
    const head = fields[i] as string;
    i += 1;
    const m = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(head);
    if (!m) throw new Error('git diff の出力を読めません');
    const status = m[3] as string;
    const first = fields[i];
    i += 1;
    if (first === undefined) throw new Error('git diff の出力を読めません');
    if (status === 'R' || status === 'C') {
      const second = fields[i];
      i += 1;
      if (second === undefined) throw new Error('git diff の出力を読めません');
      entries.push({ srcMode: m[1] as string, dstMode: m[2] as string, status, path: second, oldPath: first });
    } else {
      entries.push({ srcMode: m[1] as string, dstMode: m[2] as string, status, path: first });
    }
  }
  return entries;
}

function isForbidden(path: string, policy: RepoDiffPolicy): boolean {
  const lower = path.toLowerCase();
  return policy.forbidden.some((re) => re.test(lower));
}

function isAllowed(path: string, policy: RepoDiffPolicy): boolean {
  return policy.allowedExactPaths.includes(path) || policy.allowedPrefixes.some((prefix) => path.startsWith(prefix));
}

export interface DiffEvaluation extends ServerDiffResult {
  changedPaths: string[];
}

/**
 * 判定（純関数）。1件でも violations があれば push しない。
 * リネームは両側を調べる（禁止の場所から出す・入れるのどちらも通さない）。
 */
export function evaluateDiff(entries: readonly RawDiffEntry[], policy: RepoDiffPolicy): DiffEvaluation {
  const violations: DiffViolation[] = [];
  const humanApproval = new Set<string>();
  const changedPaths: string[] = [];

  const checkPath = (raw: string, renamed: boolean): string | null => {
    const path = normalizeRepoPath(raw);
    if (path === null) {
      violations.push({ path: raw.slice(0, 300), rule: 'invalid_path' });
      return null;
    }
    if (isForbidden(path, policy)) {
      violations.push({ path, rule: renamed ? 'rename_forbidden' : 'forbidden' });
      return null;
    }
    if (!isAllowed(path, policy)) {
      violations.push({ path, rule: renamed ? 'rename_forbidden' : 'not_allowed' });
      return null;
    }
    return path;
  };
  const isTest = (path: string): boolean => policy.protectedTestPrefixes.some((prefix) => path.startsWith(prefix));

  for (const entry of entries) {
    const renamed = entry.oldPath !== undefined;
    changedPaths.push(entry.path);
    if (entry.srcMode === MODE_SYMLINK || entry.dstMode === MODE_SYMLINK) {
      violations.push({ path: entry.path, rule: 'symlink' });
      continue;
    }
    if (entry.srcMode === MODE_SUBMODULE || entry.dstMode === MODE_SUBMODULE) {
      violations.push({ path: entry.path, rule: 'submodule' });
      continue;
    }
    const path = checkPath(entry.path, renamed);
    const old = entry.oldPath === undefined ? null : checkPath(entry.oldPath, true);
    // 追加は新しい試験なので人の承認は要らない。既存を書きかえる・消す・動かすと合格の条件を弱められる
    if (path !== null && entry.status !== 'A' && isTest(path)) humanApproval.add(path);
    if (old !== null && isTest(old)) humanApproval.add(old);
  }
  if (entries.length > policy.maxFiles) violations.push({ path: `${entries.length} files`, rule: 'too_many_files' });
  return { policyVersion: policy.version, violations, humanApproval: [...humanApproval], changedPaths };
}

/** clone 先のランナー設定か（作業場から除く対象）。 */
export function isRunnerConfigPath(path: string, patterns: readonly RegExp[]): boolean {
  const lower = path.toLowerCase();
  return patterns.some((re) => re.test(lower));
}
