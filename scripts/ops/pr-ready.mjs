#!/usr/bin/env node
/**
 * PR のマージ前ゲート（読み取り専用）。自律マージの前提を機械的に検証する。
 *
 *   node scripts/ops/pr-ready.mjs <PR番号> [--checks <name,...>] [--base <branch>]
 *                                  [--repo <owner/name>] [--json] [--help]
 *
 * 必須チェック名は --checks / MIRAI_SF_PR_READY_CHECKS が無ければ、base ブランチの
 * branch protection（required_status_checks の context / app_id）から取得する。
 * 取得できない場合は --checks を必須にして fail-closed（exit 1）。
 * --checks を指定した場合は保護設定を読まないため、strict（BEHIND）・会話解決などの保護条件は
 * 未確認であり、該当した場合は 0 を返さず 75（未確認）にする。
 *
 * 判定は「PR の statusCheckRollup に required の各チェックが success で揃っているか」まで行う。
 * 2026-11-07 の実測: workflow_dispatch で作った check run は head SHA には付くが、PR の
 * statusCheckRollup には現れず required status として評価されない。そのため v1 では
 * --dispatch を実装しない。チェックが無い場合は exit 75 で「PR-linked な run が必要
 * （head を更新して pull_request イベントを起こす）」と案内する。本ツールは push / commit /
 * merge を行わない。
 *
 * 終了コード:
 *   0   マージ可能と確認できた（必須チェックが PR の rollup に揃って success、会話解決済み、
 *       draft でない、競合なし、base 一致）
 *   75  未確認（待てば変わる）: チェック未実行・実行中、cancelled/stale、mergeable UNKNOWN、
 *       必須チェックが PR の rollup に無い（PR-linked でない）、mergeStateStatus=BLOCKED など
 *   1   失敗・照会不能（人が見る）: チェック失敗・skipped、draft、closed/merged、競合、
 *       base 不一致、保護設定不読、gh/API エラー、引数不正
 *
 * 秘密情報は出力しない（gh の認証は gh 自身に任せ、トークンを引数・ログに出さない）。
 * gh の stderr 本文は出さない（終了コード・シグナル・errno 名だけの固定分類を出す）。
 * 使うのは REST の GET と読み取り専用の GraphQL クエリだけ。mutation は発行しない。
 * bypass 用のフラグ・環境変数は無い（fail-closed）。
 */
import { execFileSync } from 'node:child_process';

const DEFAULT_REPO = 'Kensan196948G/Software-Factory';
const DEFAULT_BASE = 'main';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,200}$/;
const CHECK_PATTERN = /^[A-Za-z0-9._: -]{1,120}$/;
const SAFE_VALUE = /^[A-Za-z0-9._:@/-]{1,120}$/;
const GH_TIMEOUT_MS = 30_000;
/** PR の rollup / check-runs を 1 ページで読む上限。超えたら「情報不足」として fail-closed。 */
const PAGE_LIMIT = 100;
/** completed でも成功とみなす conclusion。 */
const OK_CONCLUSIONS = new Set(['success', 'neutral']);
/** 後続の実行に置換された可能性があり「未確認」（75）にする conclusion。 */
const NOT_READY_CONCLUSIONS = new Set(['cancelled', 'stale']);
/** 恒久的な失敗（1）にする conclusion。skipped も「黙って停滞」を避けるため 1。 */
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'skipped']);
/** まだ実行中・待機中（75）の status。 */
const PENDING_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

const PR_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      isDraft
      state
      mergeable
      mergeStateStatus
      baseRefName
      headRefName
      headRefOid
      isCrossRepository
      reviewDecision
      reviewThreads(first: 100) {
        totalCount
        pageInfo { hasNextPage }
        nodes { isResolved }
      }
      statusCheckRollup {
        contexts(first: 100) {
          totalCount
          pageInfo { hasNextPage }
          nodes {
            __typename
            ... on CheckRun { name status conclusion checkSuite { app { databaseId } } }
            ... on StatusContext { context state }
          }
        }
      }
    }
  }
}`;

function usage() {
  return [
    '使い方: node scripts/ops/pr-ready.mjs <PR番号> [--checks <name,...>] [--base <branch>]',
    '                                           [--repo <owner/name>] [--json] [--help]',
    '',
    '必須チェックは既定で base ブランチの branch protection から取得します。',
    '--checks quality,e2e,docker のように指定すると保護設定を読まずにその名前を使います。',
    'この場合 strict・会話解決・その他の保護条件は不明なため、BEHIND や未解決スレッドがあると',
    '0 を返さず 75（未確認）になります。保護条件まで確認するには保護設定が読める環境で実行してください。',
    '--json は結果を 1 行の JSON（stdout）で出し、人間向けの警告は stderr に出します。',
    '',
    'v1 では --dispatch は実装していません。workflow_dispatch の check run は PR の',
    'required status として評価されないため、チェックが無い場合は head を更新して',
    'pull_request イベントを起こしてください（本ツールは push / commit を行いません）。',
  ].join('\n');
}

const result = {
  ok: false,
  code: 1,
  pr: null,
  repo: '',
  base: '',
  head: null,
  headBranch: null,
  state: null,
  draft: null,
  mergeable: null,
  mergeStateStatus: null,
  requiredChecks: [],
  checks: [],
  missing: [],
  unresolvedThreads: null,
  reasons: [],
  warnings: [],
  queryError: false,
};

let jsonMode = false;

function usageError(message) {
  console.error(`[pr-ready] 失敗: ${message}`);
  console.error(usage());
  process.exit(1);
}

function queryError(message) {
  result.queryError = true;
  result.code = 1;
  result.ok = false;
  result.reasons = [message];
  if (jsonMode) console.log(JSON.stringify(result));
  else console.error(`[pr-ready] 照会エラー: ${message}`);
  process.exit(1);
}

function finish(code, reasons) {
  result.code = code;
  result.ok = code === 0;
  result.reasons = Array.isArray(reasons) ? reasons : [reasons];
  if (jsonMode) {
    console.log(JSON.stringify(result));
  } else if (code === 0) {
    const checks = result.checks.map((item) => `${item.name}:${item.conclusion ?? item.status}`).join(',');
    console.log(
      `[pr-ready] OK pr=${result.pr} head=${result.head} repo=${result.repo} base=${result.base} merge_state=${result.mergeStateStatus} checks=${checks}`,
    );
  } else {
    console.log(`[pr-ready] ${code === 75 ? '未確認' : '失敗'}: ${result.reasons.join(' / ')}`);
  }
  process.exit(code);
}

function warn(message) {
  result.warnings.push(message);
  if (!jsonMode) console.error(`[pr-ready] 警告: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeValue(value) {
  return typeof value === 'string' && SAFE_VALUE.test(value) ? value : '(想定外)';
}

/**
 * gh の stderr 本文は返さない。本文には URL・トークン・環境情報が含まれ得るため、
 * 終了コード・シグナル・errno 名だけの固定分類にする（check-release-ci.mjs と同じ方針）。
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

function runGh(args) {
  try {
    const stdout = execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    });
    return { stdout };
  } catch (error) {
    return { error: describeCommandError(error) };
  }
}

/** REST の GET だけを使う。JSON 不正は照会エラー。 */
function ghGet(path) {
  const run = runGh(['api', '--method', 'GET', path]);
  if (run.error) return { error: run.error };
  try {
    return { data: JSON.parse(run.stdout) };
  } catch {
    return { error: 'gh api の応答が JSON ではありません' };
  }
}

/** 読み取り専用の GraphQL クエリ。mutation は発行しない。 */
function ghGraphql(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === 'number') args.push('-F', `${key}=${value}`);
    else args.push('-f', `${key}=${value}`);
  }
  const run = runGh(args);
  if (run.error) return { error: run.error };
  try {
    return { data: JSON.parse(run.stdout) };
  } catch {
    return { error: 'gh api graphql の応答が JSON ではありません' };
  }
}

// ---- 引数 ----------------------------------------------------------------

const argv = process.argv.slice(2);
let prArg = null;
let checksRaw = null;
let base = (process.env.MIRAI_SF_PR_READY_BASE ?? '').trim() || DEFAULT_BASE;
let repo = (process.env.MIRAI_SF_PR_READY_REPO ?? '').trim() || DEFAULT_REPO;
let help = false;

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--json') {
    jsonMode = true;
    continue;
  }
  if (arg === '--help' || arg === '-h') {
    help = true;
    continue;
  }
  if (arg === '--checks' || arg === '--base' || arg === '--repo') {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) usageError(`${arg} の値がありません`);
    index += 1;
    if (arg === '--checks') checksRaw = value;
    else if (arg === '--base') base = value;
    else repo = value;
    continue;
  }
  if (arg === '--dispatch') {
    usageError(
      'v1 では --dispatch は実装していません（workflow_dispatch では required status を満たせません。head を更新して pull_request を起こしてください）',
    );
  }
  if (arg.startsWith('-')) usageError(`不明なオプションです: ${safeValue(arg)}`);
  if (prArg !== null) usageError('PR 番号が複数指定されています');
  prArg = arg;
}

if (help) {
  console.log(usage());
  process.exit(0);
}
if (prArg === null) usageError('PR 番号を指定してください');
if (!/^[1-9][0-9]{0,9}$/.test(prArg)) usageError('PR 番号は正の整数で指定してください');
const prNumber = Number(prArg);
if (!Number.isSafeInteger(prNumber)) usageError('PR 番号が大きすぎます');
if (!REPO_PATTERN.test(repo)) usageError('--repo は owner/name 形式で指定してください');
if (repo.split('/').some((part) => part === '' || part === '.' || part === '..' || part.includes('..'))) {
  usageError('--repo に不正なセグメントがあります');
}
if (!BRANCH_PATTERN.test(base) || base.includes('..')) usageError('--base が不正です');
if (checksRaw === null) checksRaw = (process.env.MIRAI_SF_PR_READY_CHECKS ?? '').trim() || null;

result.pr = prNumber;
result.repo = repo;
result.base = base;

const [owner, name] = repo.split('/');

/** --checks / 環境変数の名前リスト。null なら保護設定から読む。 */
function parseCheckNames(raw) {
  if (raw === null || raw.trim() === '') return null;
  const names = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (names.length === 0) return { error: '--checks にチェック名を指定してください' };
  for (const check of names) {
    if (!CHECK_PATTERN.test(check)) return { error: '--checks のチェック名が不正です' };
  }
  return { names: [...new Set(names)] };
}

const explicitChecks = parseCheckNames(checksRaw);
if (explicitChecks && explicitChecks.error) usageError(explicitChecks.error);

// ---- 1. PR を取得 ---------------------------------------------------------

const prResponse = ghGraphql(PR_QUERY, { owner, name, number: prNumber });
if (prResponse.error) queryError(`PR を取得できません: ${prResponse.error}`);
const pullRequest =
  isObject(prResponse.data) && isObject(prResponse.data.data) && isObject(prResponse.data.data.repository)
    ? prResponse.data.data.repository.pullRequest
    : null;
if (!isObject(pullRequest)) {
  queryError('PR が見つかりません（repository / pullRequest が応答にありません）');
}

const {
  number: gotNumber,
  isDraft,
  state,
  mergeable,
  mergeStateStatus,
  baseRefName,
  headRefName,
  headRefOid,
  isCrossRepository,
  reviewDecision,
  reviewThreads,
  statusCheckRollup,
} = pullRequest;

if (gotNumber !== prNumber || typeof isDraft !== 'boolean' || typeof state !== 'string') {
  queryError('PR のメタデータが不完全です（API 情報不足）');
}
if (typeof headRefOid !== 'string' || !SHA_PATTERN.test(headRefOid)) {
  queryError('PR の head SHA が不正です（API 情報不足）');
}
if (typeof baseRefName !== 'string' || typeof headRefName !== 'string') {
  queryError('PR の base / head ブランチ情報が不完全です（API 情報不足）');
}
if (typeof mergeable !== 'string' || typeof mergeStateStatus !== 'string') {
  queryError('PR の mergeable / mergeStateStatus が不完全です（API 情報不足）');
}

result.head = headRefOid;
result.headBranch = headRefName;
result.state = state;
result.draft = isDraft;
result.mergeable = mergeable;
result.mergeStateStatus = mergeStateStatus;

if (state !== 'OPEN') finish(1, [`PR が open ではありません（state=${safeValue(state)}）`]);
if (isDraft) finish(1, ['PR が draft です（マージ対象外）']);
if (baseRefName !== base) {
  finish(1, [`base が想定と違います（base=${safeValue(baseRefName)} / 期待 ${safeValue(base)}）`]);
}
if (headRefName === base) finish(1, ['head が base と同じブランチです']);
if (isCrossRepository) warn('fork からの PR です（読み取り専用の判定のみ行います）');
if (mergeable === 'UNKNOWN') finish(75, ['mergeable=UNKNOWN（GitHub がまだ計算していません。再実行してください）']);
if (mergeable === 'CONFLICTING') finish(1, ['mergeable=CONFLICTING（競合しています）']);
if (mergeable !== 'MERGEABLE') queryError('mergeable が想定外の値です（API 情報不足）');

// ---- 2. 必須チェック名（保護設定 or --checks） ----------------------------

let requiredChecks = [];
let strict = false;
let conversationRequired = false;

if (explicitChecks) {
  requiredChecks = explicitChecks.names.map((check) => ({ name: check, appId: null }));
  warn('--checks のため保護設定を読みません（strict・会話解決・その他の保護条件は未確認です）');
} else {
  const protectionResponse = ghGet(`repos/${repo}/branches/${encodeURIComponent(base)}/protection`);
  if (protectionResponse.error) {
    finish(1, [`保護設定を読めません（gh: ${protectionResponse.error}）。--checks で必須チェック名を指定してください`]);
  }
  const protection = protectionResponse.data;
  if (!isObject(protection)) queryError('保護設定の応答が不正です（API 情報不足）');
  const requiredStatusChecks = protection.required_status_checks;
  if (!isObject(requiredStatusChecks)) {
    finish(1, ['保護設定に required_status_checks がありません（--checks で必須チェック名を指定してください）']);
  }
  strict = requiredStatusChecks.strict === true;
  if (Array.isArray(requiredStatusChecks.checks) && requiredStatusChecks.checks.length > 0) {
    requiredChecks = requiredStatusChecks.checks
      .filter((check) => isObject(check) && typeof check.context === 'string' && CHECK_PATTERN.test(check.context))
      .map((check) => ({
        name: check.context,
        appId: Number.isSafeInteger(check.app_id) ? check.app_id : null,
      }));
  } else if (Array.isArray(requiredStatusChecks.contexts)) {
    requiredChecks = requiredStatusChecks.contexts
      .filter((check) => typeof check === 'string' && CHECK_PATTERN.test(check))
      .map((check) => ({ name: check, appId: null }));
  }
  if (requiredChecks.length === 0) {
    finish(1, ['保護設定から必須チェック名を取得できません（--checks で指定してください）']);
  }
  const conversation = protection.required_conversation_resolution;
  conversationRequired = isObject(conversation) && conversation.enabled === true;
}

result.requiredChecks = requiredChecks.map((check) => check.name);

// mergeStateStatus のうち、保護設定に依存しないものを先に判定する
if (mergeStateStatus === 'UNKNOWN') finish(75, ['mergeStateStatus=UNKNOWN（GitHub がまだ計算していません。再実行してください）']);
if (mergeStateStatus === 'DIRTY') finish(1, ['mergeStateStatus=DIRTY（競合しています）']);
if (mergeStateStatus === 'DRAFT') finish(1, ['mergeStateStatus=DRAFT（draft です）']);
if (mergeStateStatus === 'BEHIND') {
  if (explicitChecks) {
    // 保護設定を読まないため strict の値を判定できない。strict=true の PR を ready 扱いしない
    finish(75, ['mergeStateStatus=BEHIND（保護設定を読まないため strict 不明。base の最新への更新が必要か確認できません）']);
  }
  if (strict) finish(1, ['mergeStateStatus=BEHIND（保護設定 strict=true のため base の最新への更新が必要です）']);
  warn('mergeStateStatus=BEHIND（strict=false のため許容します）');
}
if (!['CLEAN', 'BLOCKED', 'BEHIND', 'UNSTABLE', 'HAS_HOOKS'].includes(mergeStateStatus)) {
  queryError('mergeStateStatus が想定外の値です（API 情報不足）');
}
if (mergeStateStatus === 'UNSTABLE') warn('mergeStateStatus=UNSTABLE（必須以外のチェックが赤または未了です）');
if (mergeStateStatus === 'HAS_HOOKS') warn('mergeStateStatus=HAS_HOOKS（マージ時にフックが実行されます）');

// ---- 3. head SHA の check run を分類 --------------------------------------

const checksResponse = ghGet(`repos/${repo}/commits/${headRefOid}/check-runs?per_page=${PAGE_LIMIT}`);
if (checksResponse.error) queryError(`check run を取得できません: ${checksResponse.error}`);
const checksPayload = checksResponse.data;
if (!isObject(checksPayload) || !Array.isArray(checksPayload.check_runs)) {
  queryError('check run の応答が不正です（API 情報不足）');
}
if (!Number.isSafeInteger(checksPayload.total_count) || checksPayload.total_count !== checksPayload.check_runs.length) {
  finish(1, ['check run の件数が不完全です（API 情報不足または未取得ページ）']);
}
if (checksPayload.total_count > PAGE_LIMIT) {
  finish(1, [`check run が ${PAGE_LIMIT} 件を超えています（情報不足）`]);
}

const failures = [];
const pending = [];
const missing = [];

for (const required of requiredChecks) {
  const candidates = checksPayload.check_runs.filter(
    (run) =>
      isObject(run) &&
      run.name === required.name &&
      run.head_sha === headRefOid &&
      (required.appId === null || (isObject(run.app) && run.app.id === required.appId)),
  );
  if (candidates.length === 0) {
    missing.push(required.name);
    continue;
  }
  const chosen = candidates.reduce((best, run) => {
    const runId = Number(run.id);
    const bestId = Number(best.id);
    if (!Number.isSafeInteger(runId)) return best;
    if (!Number.isSafeInteger(bestId)) return run;
    return runId > bestId ? run : best;
  });
  const status = typeof chosen.status === 'string' ? chosen.status.toLowerCase() : '';
  const conclusion = typeof chosen.conclusion === 'string' ? chosen.conclusion.toLowerCase() : null;
  result.checks.push({
    name: required.name,
    appId: isObject(chosen.app) && Number.isSafeInteger(chosen.app.id) ? chosen.app.id : null,
    status,
    conclusion,
  });
  if (status === 'completed') {
    if (OK_CONCLUSIONS.has(conclusion)) continue;
    if (NOT_READY_CONCLUSIONS.has(conclusion)) {
      pending.push(`${required.name}: ${conclusion}`);
      continue;
    }
    if (FAILURE_CONCLUSIONS.has(conclusion)) {
      failures.push(`${required.name}: ${conclusion}`);
      continue;
    }
    finish(1, [`必須チェック ${required.name} の conclusion が想定外です（${safeValue(String(conclusion))}）`]);
  }
  if (PENDING_STATUSES.has(status)) {
    pending.push(`${required.name}: ${status}`);
    continue;
  }
  finish(1, [`必須チェック ${required.name} の status が想定外です（${safeValue(String(status))}）`]);
}

result.missing = missing;

if (failures.length > 0) finish(1, [`必須チェックが失敗しました（${failures.join(', ')}）`]);
if (pending.length > 0) {
  finish(75, [`必須チェックが未完了です（${pending.join(', ')}）。待ってから再実行してください`]);
}
if (missing.length > 0) {
  finish(75, [
    `必須チェックがまだありません（${missing.join(', ')}）。PR-linked な run が必要です（head を更新して pull_request イベントを起こしてください）。workflow_dispatch では required status を満たせません`,
  ]);
}

// ---- 4. PR の statusCheckRollup で required が success か -------------------

/**
 * rollup の context から required 1 件の状態を分類する。
 * CheckRun は app_id が保護設定と一致するものだけを採用する（別アプリの同名チェックを成功扱いしない）。
 * 成功が 1 件でもあれば OK。失敗（failure 系）は 1、未完了（実行中・cancelled/stale 等）は 75、
 * 該当なしは missing（PR-linked な run が必要）として扱う。
 * @returns {{ state: 'success'|'failure'|'pending'|'missing', reason?: string }}
 */
function classifyRollup(contexts, required) {
  let pendingReason = null;
  let failureReason = null;
  for (const context of contexts) {
    if (!isObject(context)) continue;
    if (context.__typename === 'CheckRun') {
      if (context.name !== required.name) continue;
      if (required.appId !== null) {
        const app = isObject(context.checkSuite) && isObject(context.checkSuite.app) ? context.checkSuite.app : null;
        if (!isObject(app) || app.databaseId !== required.appId) continue;
      }
      const status = String(context.status ?? '').toLowerCase();
      const conclusion = String(context.conclusion ?? '').toLowerCase();
      if (status === 'completed' && OK_CONCLUSIONS.has(conclusion)) return { state: 'success' };
      if (status === 'completed' && FAILURE_CONCLUSIONS.has(conclusion)) {
        failureReason = `${required.name}: ${conclusion || 'failure'}`;
        continue;
      }
      if (status === 'completed' && NOT_READY_CONCLUSIONS.has(conclusion)) {
        pendingReason = `${required.name}: ${conclusion}`;
        continue;
      }
      pendingReason = `${required.name}: ${status || 'unknown'}`;
      continue;
    }
    if (context.__typename === 'StatusContext') {
      if (context.context !== required.name) continue;
      if (required.appId !== null) continue;
      const state = String(context.state ?? '').toUpperCase();
      if (state === 'SUCCESS') return { state: 'success' };
      if (state === 'FAILURE' || state === 'ERROR') {
        failureReason = `${required.name}: ${state.toLowerCase()}`;
        continue;
      }
      pendingReason = `${required.name}: ${state.toLowerCase() || 'unknown'}`;
    }
  }
  if (failureReason) return { state: 'failure', reason: failureReason };
  if (pendingReason) return { state: 'pending', reason: pendingReason };
  return { state: 'missing' };
}

const rollupContexts = isObject(statusCheckRollup) && isObject(statusCheckRollup.contexts) ? statusCheckRollup.contexts : null;
if (!rollupContexts || !Array.isArray(rollupContexts.nodes)) {
  finish(75, [
    'PR の statusCheckRollup に必須チェックがありません。PR-linked な run が必要です（head を更新して pull_request イベントを起こしてください）。workflow_dispatch では required status を満たせません',
  ]);
}
if (
  !Number.isSafeInteger(rollupContexts.totalCount) ||
  rollupContexts.totalCount !== rollupContexts.nodes.length ||
  rollupContexts.totalCount > PAGE_LIMIT ||
  rollupContexts.pageInfo?.hasNextPage === true
) {
  finish(1, [`PR の statusCheckRollup が不完全です（件数不一致・${PAGE_LIMIT} 件超・未取得ページのいずれか）`]);
}
const rollupStates = requiredChecks.map((required) => ({ required, ...classifyRollup(rollupContexts.nodes, required) }));
const rollupFailures = rollupStates.filter((item) => item.state === 'failure');
const rollupPending = rollupStates.filter((item) => item.state === 'pending');
const missingInRollup = rollupStates.filter((item) => item.state === 'missing').map((item) => item.required.name);
if (rollupFailures.length > 0) {
  finish(1, [
    `PR の statusCheckRollup で必須チェックが失敗しています（${rollupFailures.map((item) => item.reason).join(', ')}）`,
  ]);
}
if (rollupPending.length > 0) {
  finish(75, [
    `PR の statusCheckRollup で必須チェックが未完了です（${rollupPending.map((item) => item.reason).join(', ')}）。待ってから再実行してください`,
  ]);
}
if (missingInRollup.length > 0) {
  finish(75, [
    `PR の statusCheckRollup に required が揃っていません（${missingInRollup.join(', ')}）。PR-linked な run が必要です（head を更新して pull_request イベントを起こしてください）。workflow_dispatch では required status を満たせません`,
  ]);
}

// ---- 5. 会話の解決 --------------------------------------------------------

const threadNodes = isObject(reviewThreads) && Array.isArray(reviewThreads.nodes) ? reviewThreads.nodes : null;
if (conversationRequired && threadNodes === null) {
  queryError('レビュースレッドを取得できません（API 情報不足）');
}
if (
  threadNodes !== null &&
  (!Number.isSafeInteger(reviewThreads.totalCount) ||
    reviewThreads.totalCount !== threadNodes.length ||
    reviewThreads.pageInfo?.hasNextPage === true)
) {
  finish(1, [`レビュースレッドが ${PAGE_LIMIT} 件を超えているか件数が一致しません（判定不能）`]);
}
const countUnresolved = (nodes) => nodes.filter((thread) => isObject(thread) && thread.isResolved === false).length;
if (conversationRequired) {
  const unresolved = countUnresolved(threadNodes);
  result.unresolvedThreads = unresolved;
  if (unresolved > 0) finish(1, [`未解決のレビュースレッドがあります（${unresolved} 件）`]);
} else if (threadNodes !== null) {
  const unresolved = countUnresolved(threadNodes);
  result.unresolvedThreads = unresolved;
  // --checks は保護設定を読まないため、会話解決が必須か判定できない。未解決があれば 0 を返さない
  if (explicitChecks && unresolved > 0) {
    finish(75, [`未解決のレビュースレッドがあります（${unresolved} 件）。保護設定を読まないため会話解決が必須か判定できません`]);
  }
} else if (explicitChecks) {
  queryError('レビュースレッドを取得できません（API 情報不足）');
}

// ---- 6. レビュー判定 ------------------------------------------------------

if (reviewDecision === 'CHANGES_REQUESTED') finish(1, ['レビューで変更が要求されています（reviewDecision=CHANGES_REQUESTED）']);
if (reviewDecision === 'REVIEW_REQUIRED') finish(1, ['レビュー承認が必要です（reviewDecision=REVIEW_REQUIRED）']);
if (![null, 'APPROVED', 'COMMENTED', 'PENDING', 'DISMISSED'].includes(reviewDecision)) {
  queryError('reviewDecision が想定外の値です（API 情報不足）');
}

// ---- 7. 完了 --------------------------------------------------------------

// 必須チェック・会話・レビューが揃っても BLOCKED のままなら、保護の別条件を待つ（失敗にはしない）
if (mergeStateStatus === 'BLOCKED') {
  finish(75, [
    'mergeStateStatus=BLOCKED（必須チェック以外の保護条件が残っています。条件を確認するか、少し待って再実行してください）',
  ]);
}

finish(0, ['必須チェック・会話解決・base・競合の確認がすべて通りました']);
