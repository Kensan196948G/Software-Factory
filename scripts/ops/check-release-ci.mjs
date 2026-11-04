#!/usr/bin/env node
/**
 * Staging 配備の exact-main CI ゲート。
 *
 *   node scripts/ops/check-release-ci.mjs <40桁の commit SHA>
 *
 * 対象リポジトリ・workflow・イベントは固定（Kensan196948G/Software-Factory / ci.yml / push / main）。
 * 指定 SHA の push/main の ci.yml run のうち最新 run の最新 attempt を取得し、次をすべて満たす
 * ときだけ 0 を返す。1 つでも欠ける・未完了・失敗・不明なら 75（配備しない）。
 *
 *   - run の head_sha が指定 SHA と完全一致
 *   - run の event が push、head_branch が main、path が .github/workflows/ci.yml（欠落も不可）
 *   - 最新 attempt の id / run_attempt / event / path / head_sha / head_branch が一覧と一致
 *   - 最新 attempt が completed かつ conclusion=success
 *   - 必須 job（quality / e2e / docker）がすべて存在し、completed かつ conclusion=success
 *   - job 確認後にもう一度 runs を取得し、その間に新しい run/attempt が現れていないこと
 *     （再 run race を検出したら 75）
 *
 * 終了コード:
 *   0   確認できた（配備してよい）
 *   75  未確認（run/job が無い・未完了・失敗・不明・API 情報不足。配備しない）
 *   1   照会エラー（引数不正・gh/API エラー・JSON 不正）
 *
 * 秘密情報は出力しない（gh の認証は gh 自身に任せ、トークンを引数・ログに出さない）。
 * gh の stderr 本文はログへ出さない（終了コード・シグナル・errno 名だけの固定分類を出す）。
 * API の応答に必要な項目が無い場合は「情報不足」として 75（クエリ失敗の 1 とは区別する）。
 * 依存パッケージは無く、`gh api --method GET` だけを使う。
 * 手動 override / bypass 用のフラグや環境変数は無い（fail-closed）。
 * API 仕様は Context7（GitHub REST API）で確認した:
 *   GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs
 *   GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}
 *   GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs
 */
import { execFileSync } from 'node:child_process';

const REPO = 'Kensan196948G/Software-Factory';
const WORKFLOW = 'ci.yml';
const WORKFLOW_PATH = '.github/workflows/ci.yml';
const EVENT = 'push';
const BRANCH = 'main';
const REQUIRED_JOBS = ['quality', 'e2e', 'docker'];
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const GH_TIMEOUT_MS = 30_000;
const SAFE_VALUE = /^[A-Za-z0-9._:-]{1,80}$/;

const log = (message) => console.log(`[ci-gate] ${message}`);
const notReady = (message) => {
  console.error(`[ci-gate] 未確認: ${message}`);
  process.exit(75);
};
const queryError = (message) => {
  console.error(`[ci-gate] 照会エラー: ${message}`);
  process.exit(1);
};

function safeValue(value) {
  return typeof value === 'string' && SAFE_VALUE.test(value) ? value : '(想定外)';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * gh の stderr 本文は返さない。本文には URL・トークン・環境情報が含まれ得るため、
 * 終了コード・シグナル・errno 名だけの固定分類にする。
 */
function describeCommandError(error) {
  if (error && typeof error.code === 'string' && /^E[A-Z0-9_]{2,40}$/.test(error.code)) {
    return `実行エラー（${error.code}）`;
  }
  if (error && typeof error.status === 'number' && Number.isInteger(error.status)) {
    return `gh が終了コード ${error.status} で失敗しました`;
  }
  if (error && typeof error.signal === 'string' && /^[A-Z0-9]{1,20}$/.test(error.signal)) {
    return `gh がシグナル ${error.signal} で終了しました`;
  }
  return 'gh の実行に失敗しました';
}

/** gh api の GET だけを使う。コマンド失敗・JSON 不正は照会エラー（1）。 */
function ghApi(path) {
  let stdout;
  try {
    stdout = execFileSync('gh', ['api', '--method', 'GET', path], {
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    });
  } catch (error) {
    queryError(`gh api が失敗しました: ${describeCommandError(error)}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    queryError('gh api の応答が JSON ではありません');
  }
}

function runsFrom(response) {
  return isObject(response) && Array.isArray(response.workflow_runs) ? response.workflow_runs : null;
}

/** API のクエリに加えて、応答側でも SHA/event/branch/workflow を検証する。path 欠落は不可。 */
function matchingRunsFor(runs, sha) {
  return runs.filter(
    (run) =>
      isObject(run) && run.head_sha === sha && run.event === EVENT && run.head_branch === BRANCH && run.path === WORKFLOW_PATH,
  );
}

/** 最新 run を選ぶ。同時刻なら run_attempt、id の順で大きい方を優先する。 */
function latestRunOf(runs) {
  return runs.reduce((best, run) => {
    if (!best) return run;
    const runCreated = Date.parse(run.created_at ?? '') || 0;
    const bestCreated = Date.parse(best.created_at ?? '') || 0;
    if (runCreated !== bestCreated) return runCreated > bestCreated ? run : best;
    const runAttempt = Number(run.run_attempt ?? 0);
    const bestAttempt = Number(best.run_attempt ?? 0);
    if (runAttempt !== bestAttempt) return runAttempt > bestAttempt ? run : best;
    return Number(run.id ?? 0) > Number(best.id ?? 0) ? run : best;
  }, null);
}

const args = process.argv.slice(2);
if (args.length !== 1 || !SHA_PATTERN.test(args[0])) {
  queryError('使い方: node scripts/ops/check-release-ci.mjs <40桁の commit SHA>');
}
const targetSha = args[0];

const runsPath = `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?head_sha=${targetSha}&event=${EVENT}&branch=${BRANCH}&per_page=100`;
const initialRuns = runsFrom(ghApi(runsPath));
if (!initialRuns) notReady('workflow_runs が応答にありません（API 情報不足）');

const initialMatches = matchingRunsFor(initialRuns, targetSha);
if (initialMatches.length === 0) {
  notReady(`exact SHA の ${WORKFLOW} push/${BRANCH}（path=${WORKFLOW_PATH}）run がありません（sha=${targetSha}）`);
}

const latestRun = latestRunOf(initialMatches);
const runId = Number(latestRun.id);
const attemptNumber = Number(latestRun.run_attempt);
if (!Number.isInteger(runId) || runId <= 0) notReady('run id が不正です（API 情報不足）');
if (!Number.isInteger(attemptNumber) || attemptNumber <= 0) notReady('run_attempt が不正です（API 情報不足）');

const attempt = ghApi(`repos/${REPO}/actions/runs/${runId}/attempts/${attemptNumber}`);
if (!isObject(attempt)) notReady('attempt の応答が不正です（API 情報不足）');
if (
  attempt.id !== runId ||
  attempt.run_attempt !== attemptNumber ||
  attempt.event !== EVENT ||
  attempt.path !== WORKFLOW_PATH ||
  attempt.head_sha !== targetSha ||
  attempt.head_branch !== BRANCH
) {
  notReady(
    `最新 attempt のメタデータが一覧と一致しません（id=${safeValue(String(attempt.id))}, attempt=${safeValue(String(attempt.run_attempt))}, event=${safeValue(attempt.event)}, path=${safeValue(attempt.path)}）`,
  );
}
if (attempt.status !== 'completed') {
  notReady(`最新 attempt が未完了です（status=${safeValue(attempt.status)}）`);
}
if (attempt.conclusion !== 'success') {
  notReady(`最新 attempt が成功していません（conclusion=${safeValue(attempt.conclusion)}）`);
}

const jobsResponse = ghApi(`repos/${REPO}/actions/runs/${runId}/attempts/${attemptNumber}/jobs?per_page=100`);
const jobs = isObject(jobsResponse) && Array.isArray(jobsResponse.jobs) ? jobsResponse.jobs : null;
if (!jobs) notReady('jobs が応答にありません（API 情報不足）');

for (const requiredJob of REQUIRED_JOBS) {
  const namedJobs = jobs.filter((job) => isObject(job) && job.name === requiredJob);
  if (namedJobs.length === 0) notReady(`必須 job がありません: ${requiredJob}`);
  for (const job of namedJobs) {
    if (typeof job.head_sha === 'string' && job.head_sha !== targetSha) {
      notReady(`job ${requiredJob} の head_sha が一致しません（sha=${safeValue(job.head_sha)}）`);
    }
    if (job.status !== 'completed') {
      notReady(`job ${requiredJob} が未完了です（status=${safeValue(job.status)}）`);
    }
    if (job.conclusion !== 'success') {
      notReady(`job ${requiredJob} が成功していません（conclusion=${safeValue(job.conclusion)}）`);
    }
  }
}

// 再 run race の確認: job を見ている間に新しい run/attempt が始まっていないか、もう一度一覧を取る。
// 一覧の最新が検証済みの run/attempt と同一で、completed/success のままであること。
const finalRuns = runsFrom(ghApi(runsPath));
if (!finalRuns) notReady('再確認の workflow_runs が応答にありません（API 情報不足）');
const finalMatches = matchingRunsFor(finalRuns, targetSha);
if (finalMatches.length === 0) notReady('再確認で exact SHA の run が見つかりません（API 情報不足）');
const finalLatest = latestRunOf(finalMatches);
if (
  Number(finalLatest.id) !== runId ||
  Number(finalLatest.run_attempt) !== attemptNumber ||
  finalLatest.status !== 'completed' ||
  finalLatest.conclusion !== 'success'
) {
  notReady('job 確認後に新しい run/attempt が現れたか、状態が変わりました（再確認で不一致）');
}

log(
  `OK repo=${REPO} workflow=${WORKFLOW} event=${EVENT} branch=${BRANCH} sha=${targetSha} run=${runId} attempt=${attemptNumber} jobs=${REQUIRED_JOBS.join(',')}`,
);
process.exit(0);
