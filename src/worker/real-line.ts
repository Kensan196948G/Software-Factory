/**
 * 実 AI ランナーと実 GitHub の組み立て（DEVLINE_RUNNER_KIND=docker-claude）。
 * 資格情報はここでだけ読む。process.env へ入れず、子プロセスへは必要なものだけを個別に渡す（M-6）。
 */
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGithubIssueAdapter, assertApiUrlAllowed } from '../api/issue-adapter.js';
import { createGithubPrAdapter, type PrAdapter, type PullSummary } from '../api/pr-adapter.js';
import { REAL_RUNNER_POLICY, buildPrMarker, diffPolicyForRepo, jobBranchName, parsePrMarker } from '../shared/devline.js';
import type { AllowedRepo, IssueAdapter, RunnerBudget } from '../shared/devline.js';
import { createDockerClaudeRunner, type DockerClaudeRunner } from './docker-claude-runner.js';
import { assertGitBaseUrlAllowed } from './git-workspace.js';
import { createGithubCiCollector, type GithubCiCollector } from './github-ci-collector.js';

export const DEFAULT_SECRETS_PATH = join(homedir(), '.config', 'mirai-sf', 'devline-secrets.env');

export interface DevlineSecrets {
  anthropicApiKey: string;
  githubToken: string;
}

export class RealLineRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealLineRefused';
  }
}

/**
 * 資格情報のファイルを読む。symlink・通常ファイル以外・他人のファイル・0600 以外は拒否する。
 * 読むのは2つの名前だけ。値はエラーに載せない。試験では既定の path を読ませない。
 */
export function loadDevlineSecrets(path: string, nodeEnv: string): DevlineSecrets {
  if (nodeEnv === 'test' && path === DEFAULT_SECRETS_PATH) {
    throw new RealLineRefused('試験では既定の資格情報ファイルを読みません');
  }
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new RealLineRefused('資格情報のファイルがありません');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new RealLineRefused('資格情報のファイルが通常のファイルではありません');
  if ((stat.mode & 0o777) !== 0o600) throw new RealLineRefused('資格情報のファイルの権限が 0600 ではありません');
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new RealLineRefused('資格情報のファイルの所有者が実行ユーザーではありません');

  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*(ANTHROPIC_API_KEY|DEVLINE_GITHUB_TOKEN)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) values[m[1] as string] = (m[2] as string).replace(/^(['"])(.*)\1$/, '$2');
  }
  if (!values.ANTHROPIC_API_KEY || !values.DEVLINE_GITHUB_TOKEN) {
    throw new RealLineRefused('資格情報が足りません（ANTHROPIC_API_KEY / DEVLINE_GITHUB_TOKEN）');
  }
  return { anthropicApiKey: values.ANTHROPIC_API_KEY, githubToken: values.DEVLINE_GITHUB_TOKEN };
}

/** 予算の設定（純関数）。上限を超える設定と読めない値は拒否する。 */
export function parseRunnerBudget(env: Record<string, string | undefined>): RunnerBudget {
  const rawLimit = env.DEVLINE_BUDGET_JPY ?? String(REAL_RUNNER_POLICY.maxBudgetJpy);
  const rawRate = env.DEVLINE_JPY_PER_USD ?? String(REAL_RUNNER_POLICY.defaultJpyPerUsd);
  const limitJpy = Number(rawLimit);
  const jpyPerUsd = Number(rawRate);
  if (!Number.isInteger(limitJpy) || limitJpy < 1) throw new RealLineRefused('DEVLINE_BUDGET_JPY が正しくありません');
  if (limitJpy > REAL_RUNNER_POLICY.maxBudgetJpy) {
    throw new RealLineRefused(`DEVLINE_BUDGET_JPY は ${REAL_RUNNER_POLICY.maxBudgetJpy} 以下にしてください（延長しません）`);
  }
  if (!Number.isFinite(jpyPerUsd) || jpyPerUsd < 100) throw new RealLineRefused('DEVLINE_JPY_PER_USD が正しくありません');
  return { limitJpy, jpyPerUsd };
}

/** 実 runner を向けてよいか（純関数）。DEVLINE_TARGET_REPOS と定数の両方に名前と ID が載っていること。 */
export function isRealRunnerTarget(repo: string, allowed: readonly AllowedRepo[]): boolean {
  const configured = allowed.find((r) => r.name === repo);
  const fixed = REAL_RUNNER_POLICY.allowedRepos.find((r) => r.name === repo);
  return Boolean(configured && fixed && configured.repoId === fixed.repoId && diffPolicyForRepo(repo));
}

/** 設定だけで決まる起動の拒否（純関数）。接続はしない。 */
export function checkRealLineEnv(env: Record<string, string | undefined>, allowed: readonly AllowedRepo[]): string | null {
  if (env.NODE_ENV === 'production') return 'production では docker-claude を起動しません';
  if (!allowed.some((r) => isRealRunnerTarget(r.name, allowed))) {
    return 'DEVLINE_TARGET_REPOS に実 runner の許可先がありません';
  }
  const stray = allowed.filter((r) => !isRealRunnerTarget(r.name, allowed));
  if (stray.length > 0) return 'DEVLINE_TARGET_REPOS に実 runner の許可先以外が含まれています';
  try {
    parseRunnerBudget(env);
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

export type PreflightResult = { ok: true } | { ok: false; stop: 'policy' | 'unreachable'; rule: string };

export interface PublishInput {
  jobId: string;
  requestId: string;
  orderVersion: number;
  attemptNo: number;
  repo: string;
  headSha: string;
  body: string;
}

export type PublishResult =
  | { ok: true; branch: string; pr: { number: number; url: string; source: 'github' | 'fake' } }
  | { ok: false; cause: 'push_rejected' | 'pr_unknown' | 'pr_failed' | 'no_workspace' | 'repo_refused'; httpStatus?: number };

export interface RealLine {
  runner: DockerClaudeRunner;
  ci: GithubCiCollector;
  budget: RunnerBudget;
  preflight(repo: string): Promise<PreflightResult>;
  publish(input: PublishInput): Promise<PublishResult>;
  updatePrBody(input: {
    repo: string;
    number: number;
    jobId: string;
    attemptNo: number;
    headSha: string;
    body: string;
  }): Promise<boolean>;
  /** 差しかえられた PR を閉じる。マーカーと作成者が合うものだけ。merge はしない。 */
  closeSupersededPr(input: { repo: string; number: number; jobId: string }): Promise<boolean>;
}

export interface RealLineOptions {
  secrets: DevlineSecrets;
  env: Record<string, string | undefined>;
  allowedRepos: readonly AllowedRepo[];
  nodeEnv: string;
  apiUrl: string;
  gitBaseUrl: string;
  workspaceRoot?: string;
  timeoutMs?: number;
  httpTimeoutMs?: number;
  minPollIntervalMs?: number;
}

const PR_BODY_LIMIT = 60_000;

/**
 * 実 runner の起動。資格情報を読むのは worker の実行時（ここ）だけ。
 * 資格情報なし・権限違い・イメージなし・public・許可リスト外はすべて例外で起動を拒否する（fake へ落とさない）。
 */
export async function startRealLine(input: {
  env: Record<string, string | undefined>;
  allowedRepos: readonly AllowedRepo[];
  nodeEnv: string;
  apiUrl: string;
  secretsPath?: string;
  workspaceRoot?: string;
  timeoutMs?: number;
  minPollIntervalMs?: number;
}): Promise<RealLine> {
  const refused = checkRealLineEnv({ ...input.env, NODE_ENV: input.nodeEnv }, input.allowedRepos);
  if (refused) throw new RealLineRefused(refused);
  const secrets = loadDevlineSecrets(input.secretsPath ?? input.env.DEVLINE_SECRETS_FILE ?? DEFAULT_SECRETS_PATH, input.nodeEnv);
  const line = createRealLine({
    secrets,
    env: input.env,
    allowedRepos: input.allowedRepos,
    nodeEnv: input.nodeEnv,
    apiUrl: input.apiUrl,
    gitBaseUrl: input.env.DEVLINE_GIT_BASE_URL ?? 'https://github.com',
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.minPollIntervalMs === undefined ? {} : { minPollIntervalMs: input.minPollIntervalMs }),
  });
  if (!(await line.runner.checkImages())) {
    throw new RealLineRefused('実 runner のイメージがありません（docs/devline/real-runner.md の手順で作ってください）');
  }
  for (const repo of input.allowedRepos) {
    const pre = await line.preflight(repo.name);
    if (!pre.ok) throw new RealLineRefused(`対象リポジトリを使えません（${pre.rule}）`);
  }
  await line.runner.sweepOrphans();
  return line;
}

function trimBody(body: string): string {
  return body.length > PR_BODY_LIMIT ? `${body.slice(0, PR_BODY_LIMIT)}\n\n（長すぎるので以降を省略しました）\n` : body;
}

/** 実 GitHub へ送って github.com の URL が返ったものだけを実物とする（issueSourceOf と同じ考え方）。 */
export function prSourceOf(apiUrl: string, prUrl: string): 'github' | 'fake' {
  try {
    return new URL(apiUrl).hostname === 'api.github.com' && new URL(prUrl).hostname === 'github.com' ? 'github' : 'fake';
  } catch {
    return 'fake';
  }
}

async function repoFacts(
  issues: IssueAdapter,
  repo: string,
  allowed: readonly AllowedRepo[],
  signal: AbortSignal,
): Promise<PreflightResult> {
  if (!isRealRunnerTarget(repo, allowed)) return { ok: false, stop: 'policy', rule: 'target_repo_not_allowed' };
  const expected = allowed.find((r) => r.name === repo) as AllowedRepo;
  const id = await issues.getRepoId(repo, signal);
  if (!id.ok) return { ok: false, stop: 'unreachable', rule: 'repo_unreadable' };
  if (id.value !== expected.repoId) return { ok: false, stop: 'policy', rule: 'repo_id_mismatch' };
  const flag = await issues.getRepoPrivate(repo, signal);
  if (!flag.ok) return { ok: false, stop: 'unreachable', rule: 'repo_unreadable' };
  if (flag.value !== true) return { ok: false, stop: 'policy', rule: 'repo_public' };
  return { ok: true };
}

/** 照合。マーカー・作成者・head が全部合うものだけを同じ PR とみなす。 */
function matchPull(
  pulls: readonly PullSummary[],
  marker: string,
  actor: string,
  repo: string,
  headSha: string,
): PullSummary | null {
  const hits = pulls
    .filter((p) => p.authorLogin === actor && p.headSha === headSha && p.headRepo === repo)
    .filter((p) => ((p.body ?? '').split('\n', 1)[0] ?? '').replace(/\r$/, '') === marker)
    .sort((a, b) => a.number - b.number);
  return hits[0] ?? null;
}

export function createRealLine(options: RealLineOptions): RealLine {
  const budget = parseRunnerBudget(options.env);
  assertApiUrlAllowed(options.apiUrl, options.nodeEnv);
  assertGitBaseUrlAllowed(options.gitBaseUrl, options.nodeEnv);
  const httpTimeoutMs = options.httpTimeoutMs ?? 30_000;
  const adapterOptions = { token: options.secrets.githubToken, apiUrl: options.apiUrl, nodeEnv: options.nodeEnv };
  const issues = createGithubIssueAdapter(adapterOptions);
  const prs: PrAdapter = createGithubPrAdapter(adapterOptions);
  const runner = createDockerClaudeRunner({
    apiKey: options.secrets.anthropicApiKey,
    gitToken: options.secrets.githubToken,
    gitBaseUrl: options.gitBaseUrl,
    nodeEnv: options.nodeEnv,
    budget,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const ci = createGithubCiCollector({
    ...adapterOptions,
    httpTimeoutMs,
    ...(options.minPollIntervalMs === undefined ? {} : { minPollIntervalMs: options.minPollIntervalMs }),
  });
  const signal = (): AbortSignal => AbortSignal.timeout(httpTimeoutMs);

  return {
    runner,
    ci,
    budget,
    preflight: (repo) => repoFacts(issues, repo, options.allowedRepos, signal()),

    async publish(input) {
      const workspace = runner.workspaceOf({ jobId: input.jobId, attemptNo: input.attemptNo });
      if (!workspace) return { ok: false, cause: 'no_workspace' };
      const facts = await repoFacts(issues, input.repo, options.allowedRepos, signal());
      if (!facts.ok) return { ok: false, cause: 'repo_refused' };
      const actor = await issues.getActorLogin(signal());
      if (!actor.ok) return { ok: false, cause: 'repo_refused' };
      const defaultBranch = await readDefaultBranch(options, input.repo, signal());
      if (defaultBranch === null) return { ok: false, cause: 'repo_refused' };

      const branch = jobBranchName(input.requestId, input.orderVersion, input.attemptNo);
      try {
        await workspace.push(input.headSha, branch);
      } catch {
        return { ok: false, cause: 'push_rejected' };
      }

      const marker = buildPrMarker({ jobId: input.jobId, attemptNo: input.attemptNo, headSha: input.headSha });
      const body = trimBody(`${marker}\n\n${input.body}`);
      const title = `[AI候補] ${input.requestId} v${input.orderVersion} a${input.attemptNo}`;
      const send = () => prs.createPull({ repo: input.repo, title, body, head: branch, base: defaultBranch }, signal());
      const lookup = async (): Promise<PullSummary | null | 'error'> => {
        const listed = await prs.listPullsByHead({ repo: input.repo, branch }, signal());
        if (!listed.ok) return 'error';
        return matchPull(listed.value, marker, actor.value, input.repo, input.headSha);
      };
      const done = (pull: PullSummary): PublishResult => ({
        ok: true,
        branch,
        pr: { number: pull.number, url: pull.url, source: prSourceOf(options.apiUrl, pull.url) },
      });

      const first = await send();
      if (first.outcome === 'succeeded') return done(first.pull);
      if (first.outcome === 'failed' && !first.alreadyExists)
        return { ok: false, cause: 'pr_failed', httpStatus: first.httpStatus };
      if (first.outcome === 'rate_limited') return { ok: false, cause: 'pr_unknown', httpStatus: first.httpStatus };

      // 応答を失った。作られているかをリストで確かめ、無いときだけもう一度送る。
      // 同じ head の PR は GitHub が2つ作らない（422）ので、この再送で二重にはならない
      const found = await lookup();
      if (found === 'error') return { ok: false, cause: 'pr_unknown' };
      if (found) return done(found);
      if (first.outcome === 'failed') return { ok: false, cause: 'pr_failed', httpStatus: first.httpStatus };
      const second = await send();
      if (second.outcome === 'succeeded') return done(second.pull);
      const again = await lookup();
      if (again !== 'error' && again) return done(again);
      return { ok: false, cause: 'pr_unknown' };
    },

    async updatePrBody(input) {
      const marker = buildPrMarker({ jobId: input.jobId, attemptNo: input.attemptNo, headSha: input.headSha });
      const result = await prs.updatePullBody(
        { repo: input.repo, number: input.number, body: trimBody(`${marker}\n\n${input.body}`) },
        signal(),
      );
      return result.outcome === 'succeeded';
    },

    async closeSupersededPr(input) {
      if (!(await isOwnPull(issues, input, signal))) return false;
      const result = await prs.closePull({ repo: input.repo, number: input.number }, signal());
      return result.outcome === 'succeeded';
    },
  };
}

/** 閉じる前に PR を読み、この job が作ったものか確かめる。 */
async function isOwnPull(
  issues: IssueAdapter,
  input: { repo: string; number: number; jobId: string },
  signal: () => AbortSignal,
): Promise<boolean> {
  const issue = await issues.getIssue(input.repo, input.number, signal());
  if (!issue.ok || !issue.value || !issue.value.isPullRequest) return false;
  const actor = await issues.getActorLogin(signal());
  if (!actor.ok || issue.value.authorLogin !== actor.value) return false;
  return parsePrMarker(issue.value.body)?.jobId === input.jobId;
}

async function readDefaultBranch(options: RealLineOptions, repo: string, signal: AbortSignal): Promise<string | null> {
  const base = assertApiUrlAllowed(options.apiUrl, options.nodeEnv).toString().replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/repos/${repo}`, {
      headers: {
        authorization: `Bearer ${options.secrets.githubToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'mirai-sf-devline',
        'x-github-api-version': '2022-11-28',
      },
      signal,
      redirect: 'manual',
    });
    if (!res.ok) return null;
    const branch = ((await res.json()) as { default_branch?: unknown }).default_branch;
    return typeof branch === 'string' && /^[A-Za-z0-9._/-]+$/.test(branch) ? branch : null;
  } catch {
    return null;
  }
}
