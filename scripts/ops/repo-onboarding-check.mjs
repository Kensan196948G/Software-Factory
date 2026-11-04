#!/usr/bin/env node
/**
 * 2つ目のリポジトリを開発ラインに載せてよいかを、`gh` の**読取りだけ**で検査する。
 *
 * 選ぶのは人間（`docs/devline/repo-onboarding.md` 7章）。このスクリプトは、選んだ repo が
 * オンボーディングの前提（同 2章）を満たしているかを1コマンドで確かめ、状態を PASS / FAIL /
 * UNKNOWN の表と JSON で出す。
 *
 * 検査する項目（すべて `gh api` の GET）:
 *   1. repository        リポジトリを取得できる（404 は「無い」か「読めない」）
 *   2. private           非公開か（L-14: 公開は投入できない。例外設定は作らない）
 *   3. archived          アーカイブされていないか
 *   4. default_branch    既定ブランチがあるか（保護と CI の対象）
 *   5. required_checks   既定ブランチの保護に required_status_checks があるか
 *   6. ci_workflow       `.github/workflows/ci.yml` が有効か（Dependabot の動的 workflow は除く）
 *   7. latest_ci         直近の pull_request の CI が success で、job がすべて success か
 *                        （skip / cancelled / failure が1つでもあれば不合格。同 2章）
 *   8. ac_results        直近の CI の run に artifact 名 `ac-results` があるか
 *                        （**名前と存在だけ**を見る。zip は落とさず、v2 の中身も読まない）
 *
 * 何をしないか（禁止事項の担保）:
 *   - 書込みをしない。`gh api` は GET のみ（`--method` を渡さない）。PR も作らない。
 *   - 他のリポジトリ・設定・配備・systemd・DB・Cloudflare に触れない。
 *   - 秘密を出さない。gh の資格情報（`~/.config/gh/hosts.yml`）は gh 自身に読ませ、
 *     トークン値を argv・環境変数・出力へ出さない。gh のエラー文は URL とトークン様の
 *     文字列を伏せてから出す。
 *   - artifact の中身を読まない（v2 形式かどうかは、このスクリプトでは判定しない。
 *     `ac-results` v2 の検証は実 runner 側の仕事。`docs/devline/real-runner.md`）。
 *
 * 使い方:
 *   node scripts/ops/repo-onboarding-check.mjs <owner/name>
 *   node scripts/ops/repo-onboarding-check.mjs <owner/name> --json
 *   pnpm ops:repo-check <owner/name>
 *
 * 終了コード: 0=PASS（FAIL も UNKNOWN も無い）/ 1=FAIL あり / 2=UNKNOWN あり（FAIL は無い）
 *             64=使い方の誤り（引数なし・owner/name の形でない・不明なオプション）
 */
import { spawnSync } from 'node:child_process';

const TOOL = 'repo-onboarding-check';
const TOOL_VERSION = '1.0.0';
/** gh 1 回あたりの上限。ネットワークが固まっても止まるようにする。 */
const GH_TIMEOUT_MS = 20000;
/** 一覧 API の1ページ分。100 を超える古い workflow / artifact は見ない（新しい順）。 */
const PAGE_SIZE = 100;
/** pull_request の run を探す件数（新しい順）。 */
const RUN_PAGE_SIZE = 50;
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_UNKNOWN = 2;
const EXIT_USAGE = 64;
/** owner/name。owner は GitHub のユーザー名・組織名、name は英数字と -._ のみ。 */
const TARGET_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** 開発ラインの前提とする CI（docs/devline/repo-onboarding.md 2章）。 */
const CI_WORKFLOW_PATH = /^\.github\/workflows\/ci\.ya?ml$/;
/** 開発ラインが根拠にする artifact（名前だけを見る）。 */
const AC_RESULTS_ARTIFACT = 'ac-results';
/** 出力に載せる前に1行へ潰す長さ。 */
const ONE_LINE_MAX = 160;

const PASS = 'PASS';
const FAIL = 'FAIL';
const UNKNOWN = 'UNKNOWN';

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// 1. 引数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { help: false, json: false, target: null };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('-')) throw new UsageError(`不明なオプション: ${arg}`);
    else if (options.target === null) options.target = arg;
    else throw new UsageError(`対象は1つだけ指定できます（余分な引数: ${arg}）`);
  }
  if (options.help) return options;
  if (options.target === null) throw new UsageError('対象リポジトリ（owner/name）を指定してください');
  if (!TARGET_PATTERN.test(options.target)) {
    throw new UsageError('対象は owner/name の形で指定してください（英数字・- . _ のみ。URL や git@ は受け付けません）');
  }
  return options;
}

function printUsage() {
  process.stdout.write(
    [
      '使い方: node scripts/ops/repo-onboarding-check.mjs <owner/name> [--json]',
      '',
      '  <owner/name>   検査するリポジトリ（例: Kensan196948G/Software-Factory）',
      '  --json         結果を JSON で stdout へ出す（機械可読。診断は stderr）',
      '  --help, -h     この使い方を表示する',
      '',
      '検査（すべて gh api の GET。書込みはしない）:',
      '  repository / private / archived / default_branch / required_checks /',
      '  ci_workflow / latest_ci / ac_results',
      '',
      'PASS の条件（docs/devline/repo-onboarding.md 2章）:',
      '  非公開・アーカイブでない・既定ブランチがある・保護に required_status_checks がある・',
      '  .github/workflows/ci.yml が有効・直近の pull_request の CI で全 job が success・',
      '  その run に artifact 名 ac-results がある（中身は読まない）',
      '',
      '読取り専用: PR も設定も作らない。artifact の中身は落とさない。トークンは出力しない。',
      '終了コード: 0=PASS / 1=FAIL あり / 2=UNKNOWN あり（FAIL は無い）/ 64=使い方の誤り',
      '判定の意味は docs/devline/repo-onboarding.md の「検証（1コマンド）」を参照。',
    ].join('\n') + '\n',
  );
}

// ---------------------------------------------------------------------------
// 2. gh の呼出し（GET のみ・秘密を出さない）
// ---------------------------------------------------------------------------

/** 出力に載せる前に1行へ潰す（改行で表やログを壊さない）。 */
function oneLine(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, ONE_LINE_MAX);
}

/** 表示幅（CJK・全角記号を 2 桁として数える。表の桁を揃えるため）。 */
function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 表示幅で右を空白で埋める（`String.padEnd` は CJK を 1 桁と数えるため使わない）。 */
function padWidth(text, width) {
  const raw = String(text);
  return raw + ' '.repeat(Math.max(0, width - displayWidth(raw)));
}

/** GitHub の REST は visibility を小文字で返す。表示は大文字に揃える。 */
function visibilityLabel(repo) {
  const raw = typeof repo?.visibility === 'string' ? repo.visibility : '';
  return raw ? raw.toUpperCase() : '(不明)';
}

/** gh のエラー文から URL とトークン様の文字列を伏せる（資格情報を外へ出さない）。 */
function sanitize(text) {
  return oneLine(
    String(text ?? '')
      .replace(/gh[pousr]_[A-Za-z0-9]{10,}/g, '[REDACTED]')
      .replace(/github_pat_[A-Za-z0-9_]{10,}/g, '[REDACTED]')
      .replace(/https?:\/\/\S+/g, '[URL]'),
  );
}

/** gh の失敗を、対処の分かる種類に落とす。 */
function classifyFailure(stderr) {
  const text = String(stderr ?? '');
  if (/Branch not protected/i.test(text)) return 'not_protected';
  if (/\bHTTP 404\b|Not Found/i.test(text)) return 'not_found';
  if (/\bHTTP 401\b|Bad credentials|authentication/i.test(text)) return 'unauthorized';
  if (/\bHTTP 403\b|Forbidden|rate limit/i.test(text)) return 'forbidden';
  if (/could not resolve host|dial tcp|connection refused|i\/o timeout/i.test(text)) return 'network';
  return 'error';
}

/**
 * `gh api <path>` を実行して JSON を返す。`--method` は渡さない（GET のみ）。
 * @returns {{ok: true, data: unknown} | {ok: false, kind: string, message: string}}
 */
function ghApi(path) {
  const result = spawnSync('gh', ['api', path], {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    // gh は自分の資格情報（~/.config/gh/hosts.yml）で認証する。トークン値は argv に載せない。
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    const code = result.error.code;
    if (code === 'ENOENT') return { ok: false, kind: 'gh_missing', message: 'gh が見つからない（PATH を確認する）' };
    if (code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
      return { ok: false, kind: 'timeout', message: `gh が ${GH_TIMEOUT_MS}ms 以内に応答しない` };
    }
    return { ok: false, kind: 'spawn', message: `gh を起動できない（${oneLine(code) || 'unknown'}）` };
  }
  if (result.status !== 0) {
    const kind = classifyFailure(result.stderr);
    const message = sanitize(result.stderr) || `gh が終了コード ${result.status} で失敗した`;
    return { ok: false, kind, message };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout || 'null') };
  } catch {
    return { ok: false, kind: 'parse', message: '応答を JSON として読めない' };
  }
}

/** 失敗の種類から、その検査の状態と理由を作る（404 だけは FAIL、他は UNKNOWN）。 */
function describeFailure(failure, context) {
  const reason = failure.message || failure.kind;
  switch (failure.kind) {
    case 'not_found':
      return { status: FAIL, detail: `${context}が見つからない（404。無い、または gh のアカウントが読めない）` };
    case 'unauthorized':
      return { status: UNKNOWN, detail: `認証できない（${reason}）。gh auth login の状態を確認する` };
    case 'forbidden':
      return { status: UNKNOWN, detail: `読取りが拒否された（${reason}）。gh の権限・レート制限を確認する` };
    case 'network':
      return { status: UNKNOWN, detail: `GitHub へ到達できない（${reason}）` };
    case 'gh_missing':
      return { status: UNKNOWN, detail: 'gh が見つからない（PATH と gh auth login の状態を確認する）' };
    case 'timeout':
      return { status: UNKNOWN, detail: `${reason}（ネットワークか gh の応答を確認する）` };
    default:
      return { status: UNKNOWN, detail: `${context}を取得できない（${reason}）` };
  }
}

// ---------------------------------------------------------------------------
// 3. 検査
// ---------------------------------------------------------------------------

function describeRun(run) {
  const sha = typeof run?.head_sha === 'string' ? run.head_sha.slice(0, 7) : '';
  return `run ${run?.id ?? '?'}${sha ? `（${sha}）` : ''}`;
}

/** 保護の応答から必須チェックの名前を取り出す（`contexts` と `checks[].context` の両対応）。 */
function requiredCheckNames(protection) {
  const required = protection?.required_status_checks;
  if (!required) return [];
  if (Array.isArray(required.contexts) && required.contexts.length > 0) {
    return required.contexts.filter((c) => typeof c === 'string');
  }
  if (Array.isArray(required.checks)) {
    return required.checks.map((c) => c?.context).filter((c) => typeof c === 'string');
  }
  return [];
}

function checkRepository(checks, target) {
  const [owner, name] = target.split('/');
  const result = ghApi(`repos/${owner}/${name}`);
  if (!result.ok) {
    const { status, detail } = describeFailure(result, 'リポジトリ');
    checks.push({
      id: 'repository',
      status,
      detail: status === FAIL ? `${detail}。owner/name の綴りと、gh のアカウントが読める範囲を確認する` : detail,
    });
    return null;
  }
  const repo = result.data ?? {};
  checks.push({ id: 'repository', status: PASS, detail: `id=${oneLine(repo.id)}` });
  return repo;
}

function checkRepoFlags(checks, repo) {
  const visibility = visibilityLabel(repo);
  const isPrivate = repo.private === true || String(repo.visibility).toUpperCase() === 'PRIVATE';
  checks.push({
    id: 'private',
    status: isPrivate ? PASS : FAIL,
    detail: isPrivate
      ? `非公開（visibility=${visibility}）`
      : `公開（visibility=${visibility}）。L-14 により投入できない（例外の設定は作らない）`,
  });

  const archived = repo.archived === true;
  checks.push({
    id: 'archived',
    status: archived ? FAIL : PASS,
    detail: archived ? 'アーカイブされている（読取り専用。投入先にしない）' : 'アーカイブされていない',
  });

  const branch = typeof repo.default_branch === 'string' ? repo.default_branch : '';
  checks.push({
    id: 'default_branch',
    status: branch ? PASS : FAIL,
    detail: branch ? branch : '既定ブランチが無い（空のリポジトリか、読取り範囲外）',
  });
  return branch;
}

function checkRequiredChecks(checks, target, branch) {
  if (!branch) {
    checks.push({ id: 'required_checks', status: UNKNOWN, detail: '既定ブランチが分からないため保護を確認できない' });
    return;
  }
  const [owner, name] = target.split('/');
  const result = ghApi(`repos/${owner}/${name}/branches/${branch}/protection`);
  if (!result.ok) {
    if (result.kind === 'not_protected') {
      checks.push({
        id: 'required_checks',
        status: FAIL,
        detail: `${branch} が保護されていない（必須チェックが無い。自動マージの前提を満たさない）`,
      });
      return;
    }
    if (result.kind === 'not_found') {
      checks.push({ id: 'required_checks', status: FAIL, detail: `${branch} の保護を取得できない（404）` });
      return;
    }
    const { status, detail } = describeFailure(result, 'ブランチ保護');
    checks.push({ id: 'required_checks', status, detail });
    return;
  }
  const names = requiredCheckNames(result.data);
  checks.push({
    id: 'required_checks',
    status: names.length > 0 ? PASS : FAIL,
    detail:
      names.length > 0
        ? `必須チェック: ${oneLine(names.join(', '))}`
        : '保護はあるが required_status_checks が無い（必須チェックを設定する）',
  });
}

function checkCiWorkflow(checks, target) {
  const [owner, name] = target.split('/');
  const result = ghApi(`repos/${owner}/${name}/actions/workflows?per_page=${PAGE_SIZE}`);
  if (!result.ok) {
    const { status, detail } = describeFailure(result, 'workflow 一覧');
    checks.push({ id: 'ci_workflow', status, detail });
    return null;
  }
  const all = Array.isArray(result.data?.workflows) ? result.data.workflows : [];
  // Dependabot の動的 workflow（path が dynamic/...）は CI と数えない。
  const own = all.filter((w) => typeof w.path === 'string' && !w.path.startsWith('dynamic/'));
  const active = own.filter((w) => w.state === 'active');
  const ci = active.find((w) => CI_WORKFLOW_PATH.test(w.path));
  if (ci) {
    checks.push({ id: 'ci_workflow', status: PASS, detail: `${ci.path}（id=${oneLine(ci.id)}）` });
    return ci;
  }
  checks.push({
    id: 'ci_workflow',
    status: FAIL,
    detail:
      active.length > 0
        ? `.github/workflows/ci.yml が無い（有効な workflow: ${oneLine(active.map((w) => w.path).join(', '))}）`
        : '有効な workflow が無い（CI を用意する）',
  });
  return null;
}

function checkLatestCi(checks, target, ciWorkflow) {
  if (!ciWorkflow) {
    checks.push({ id: 'latest_ci', status: UNKNOWN, detail: 'ci.yml が無いため直近の CI を確認できない' });
    return null;
  }
  const [owner, name] = target.split('/');
  const result = ghApi(
    `repos/${owner}/${name}/actions/workflows/${ciWorkflow.id}/runs?per_page=${RUN_PAGE_SIZE}&event=pull_request`,
  );
  if (!result.ok) {
    const { status, detail } = describeFailure(result, 'CI の実行');
    checks.push({ id: 'latest_ci', status, detail });
    return null;
  }
  const runs = Array.isArray(result.data?.workflow_runs) ? result.data.workflow_runs : [];
  const completed = runs.filter((r) => r.event === 'pull_request' && r.status === 'completed');
  if (completed.length === 0) {
    checks.push({
      id: 'latest_ci',
      status: FAIL,
      detail: 'pull_request の CI 実行がまだ無い（run 全体の success を確認できない）',
    });
    return null;
  }
  const run = completed[0];
  const jobs = ghApi(`repos/${owner}/${name}/actions/runs/${run.id}/jobs?per_page=${PAGE_SIZE}`);
  if (!jobs.ok) {
    const { status, detail } = describeFailure(jobs, 'CI の job');
    checks.push({ id: 'latest_ci', status, detail: `${describeRun(run)} の job を確認できない: ${detail}` });
    return run;
  }
  const list = Array.isArray(jobs.data?.jobs) ? jobs.data.jobs : [];
  const notSuccess = list.filter((j) => j.conclusion !== 'success');
  const names = (items) => oneLine(items.map((j) => `${oneLine(j.name)}(${oneLine(j.conclusion)})`).join(', '));
  if (run.conclusion !== 'success') {
    checks.push({
      id: 'latest_ci',
      status: FAIL,
      detail: `${describeRun(run)} が ${oneLine(run.conclusion) || '未確定'}${notSuccess.length > 0 ? `。success でない job: ${names(notSuccess)}` : ''}`,
    });
    return run;
  }
  if (list.length === 0) {
    checks.push({ id: 'latest_ci', status: FAIL, detail: `${describeRun(run)} の job を読めない（job が 0 件）` });
    return run;
  }
  if (notSuccess.length > 0) {
    checks.push({
      id: 'latest_ci',
      status: FAIL,
      detail: `${describeRun(run)} は success だが success でない job がある: ${names(notSuccess)}（skip / cancelled は不合格）`,
    });
    return run;
  }
  checks.push({
    id: 'latest_ci',
    status: PASS,
    detail: `${describeRun(run)} は success、job ${list.length} 件すべて success`,
  });
  return run;
}

function checkAcResults(checks, target, latestRun) {
  const [owner, name] = target.split('/');
  const result = ghApi(`repos/${owner}/${name}/actions/artifacts?per_page=${PAGE_SIZE}`);
  if (!result.ok) {
    const { status, detail } = describeFailure(result, 'artifact 一覧');
    checks.push({ id: 'ac_results', status, detail });
    return;
  }
  const all = Array.isArray(result.data?.artifacts) ? result.data.artifacts : [];
  const named = all.filter((a) => a.name === AC_RESULTS_ARTIFACT);
  const alive = named.filter((a) => a.expired !== true);
  if (alive.length === 0) {
    checks.push({
      id: 'ac_results',
      status: FAIL,
      detail:
        named.length > 0
          ? `${AC_RESULTS_ARTIFACT} はあるがすべて期限切れ（新しい CI で出す）`
          : `${AC_RESULTS_ARTIFACT} が無い（CI で artifact 名 ${AC_RESULTS_ARTIFACT} を出す）`,
    });
    return;
  }
  const runId = latestRun?.id;
  const inSameRun = runId !== undefined && alive.some((a) => a?.workflow_run?.id === runId);
  if (inSameRun) {
    checks.push({
      id: 'ac_results',
      status: PASS,
      detail: `${describeRun({ id: runId })} に ${AC_RESULTS_ARTIFACT} がある（名前と存在だけを確認。中身は読まない）`,
    });
    return;
  }
  if (runId !== undefined) {
    checks.push({
      id: 'ac_results',
      status: FAIL,
      detail: `${describeRun({ id: runId })} には無い（他の run に ${alive.length} 件）。v2 は「同じ run」に要る`,
    });
    return;
  }
  checks.push({
    id: 'ac_results',
    status: UNKNOWN,
    detail: `${AC_RESULTS_ARTIFACT} は存在する（${alive.length} 件）が、直近の CI の run と突き合わせられない`,
  });
}

function inspect(target) {
  const checks = [];
  const repo = checkRepository(checks, target);
  if (!repo) return { checks, repo: null };
  const branch = checkRepoFlags(checks, repo);
  checkRequiredChecks(checks, target, branch);
  const ciWorkflow = checkCiWorkflow(checks, target);
  const latestRun = checkLatestCi(checks, target, ciWorkflow);
  checkAcResults(checks, target, latestRun);
  return { checks, repo };
}

// ---------------------------------------------------------------------------
// 4. 判定と表示
// ---------------------------------------------------------------------------

function summarize(checks) {
  const counts = { PASS: 0, FAIL: 0, UNKNOWN: 0 };
  for (const check of checks) counts[check.status] += 1;
  /** FAIL があれば FAIL。FAIL が無く UNKNOWN があれば UNKNOWN。どちらも無ければ PASS。 */
  if (counts.FAIL > 0) return { verdict: FAIL, exitCode: EXIT_FAIL, counts };
  if (counts.UNKNOWN > 0) return { verdict: UNKNOWN, exitCode: EXIT_UNKNOWN, counts };
  return { verdict: PASS, exitCode: EXIT_PASS, counts };
}

function daysSince(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const days = (Date.now() - date.getTime()) / 86400000;
  return days < 0 ? 0 : Math.floor(days);
}

function formatPushedAt(iso) {
  const days = daysSince(iso);
  return days === null ? oneLine(iso) || '-' : `${oneLine(iso)}（${days}日前）`;
}

function printHuman(target, repo, checks, summary) {
  const print = (line = '') => process.stdout.write(`${line}\n`);
  print(`${TOOL} v${TOOL_VERSION}`);
  print(`対象: ${target}`);
  if (repo) {
    print(`可視性: ${visibilityLabel(repo)} / 既定ブランチ: ${oneLine(repo.default_branch) || '-'}`);
    print(`最終 push: ${formatPushedAt(repo.pushed_at)} / リポジトリID: ${oneLine(repo.id)}`);
    print(`アーカイブ: ${repo.archived === true ? 'はい' : 'いいえ'}`);
  }
  print();
  print(`${padWidth('状態', 9)}${padWidth('検査', 19)}結果`);
  for (const check of checks) print(`${padWidth(check.status, 9)}${padWidth(check.id, 19)}${check.detail}`);
  print();
  print(
    `総合判定: ${summary.verdict}（PASS ${summary.counts.PASS} / FAIL ${summary.counts.FAIL} / UNKNOWN ${summary.counts.UNKNOWN}）`,
  );
  if (summary.verdict === PASS) {
    print('→ 前提は満たしている。台帳と設定への追加は docs/devline/repo-onboarding.md の手順で行う（選ぶのは人間）。');
  } else if (summary.verdict === FAIL) {
    print('→ 対処は docs/devline/repo-onboarding.md の「FAIL したときの対処」を見る。');
  } else {
    print('→ 判定できない検査がある（UNKNOWN）。理由を解消してから再実行する。');
  }
}

function buildReport(target, repo, checks, summary) {
  return {
    tool: TOOL,
    version: TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    target,
    verdict: summary.verdict,
    exitCode: summary.exitCode,
    counts: summary.counts,
    repo: repo
      ? {
          id: repo.id ?? null,
          visibility: repo.visibility ?? null,
          private: repo.private === true || repo.visibility === 'PRIVATE',
          archived: repo.archived === true,
          defaultBranch: repo.default_branch ?? null,
          pushedAt: repo.pushed_at ?? null,
        }
      : null,
    checks,
    /** artifact の中身は読まない（名前と存在だけ）。 */
    artifactContentsRead: false,
    notes: [
      'gh api の GET のみ。書込み・PR 作成・設定変更はしない。',
      'ac-results は名前と存在だけを見る（v2 かどうかは実 runner 側で検証する）。',
      '最新 push 日時は判定に使わない（表示のみ）。基準は docs/devline/repo-onboarding.md 2章。',
    ],
  };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${TOOL}: ${error.message}\n\n`);
    printUsage();
    process.exit(EXIT_USAGE);
  }
  if (options.help) {
    printUsage();
    process.exit(EXIT_PASS);
  }

  const { checks, repo } = inspect(options.target);
  const summary = summarize(checks);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(buildReport(options.target, repo, checks, summary), null, 2)}\n`);
  } else {
    printHuman(options.target, repo, checks, summary);
  }
  process.exit(summary.exitCode);
}

main();
