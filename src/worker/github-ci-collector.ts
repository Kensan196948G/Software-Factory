/**
 * 独立 CI の結果の収集（GitHub Actions）。合否の根拠は Actions の記録だけ。ランナーの自己申告を使わない。
 *
 * 証拠として認める run の条件: head SHA・workflow の path・event・リポジトリ・PR の head が一致すること。
 * workflow ファイルが base と同じ blob でなければ policy_violation で止める（AI が弱めた workflow を受け入れない）。
 * 読むのは Actions（Read）と Contents（Read）の範囲。再実行は要求しない。
 */
import { createHash } from 'node:crypto';
import { assertApiUrlAllowed } from '../api/issue-adapter.js';
import { REAL_RUNNER_POLICY, REQUIRED_STAGES } from '../shared/devline.js';
import type { RecordVerificationInput, StageResult, StageStatus, StopReason } from '../shared/devline.js';

export interface CiJobFacts {
  id: string;
  head_sha: string | null;
  target_repo_id: string;
  work_state: Record<string, unknown>;
  base_sha: string;
}

export type CiCollectResult = RecordVerificationInput | null | { halt: { reason: StopReason; detail: unknown } };

export interface GithubCiCollectorOptions {
  token: string;
  apiUrl: string;
  nodeEnv: string;
  /** 同じ job をこれより短い間隔で問い合わせない。 */
  minPollIntervalMs?: number;
  httpTimeoutMs?: number;
}

export interface GithubCiCollector {
  collect(job: CiJobFacts, ctx: { now: Date; correlationId: string; acIds: readonly string[] }): Promise<CiCollectResult>;
}

interface WorkflowRun {
  id: number;
  run_number: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string | null;
  path: string;
  event: string;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  head_repository?: { full_name?: string } | null;
  repository?: { full_name?: string } | null;
  pull_requests?: { number?: number }[] | null;
}

interface WorkflowJob {
  name: string;
  head_sha?: string;
  status: string | null;
  conclusion: string | null;
  html_url?: string | null;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** run の条件（純関数）。合わない run は証拠にしない。 */
export function isEvidenceRun(
  run: WorkflowRun,
  expected: { repo: string; headSha: string; branch: string | null; prNumber: number | null },
): boolean {
  if (run.head_sha !== expected.headSha) return false;
  if (run.path !== REAL_RUNNER_POLICY.ciWorkflowPath) return false;
  if (run.event !== REAL_RUNNER_POLICY.ciEvent) return false;
  if (run.repository?.full_name !== expected.repo || run.head_repository?.full_name !== expected.repo) return false;
  if (expected.branch !== null && run.head_branch !== expected.branch) return false;
  // 同じリポジトリの PR なら pull_requests に載る。載っていて別の番号なら別の PR の run
  const prs = run.pull_requests ?? [];
  if (expected.prNumber !== null && prs.length > 0 && !prs.some((p) => p.number === expected.prNumber)) return false;
  return true;
}

/** job の結論から段階の状態へ（純関数）。success だけが passed。 */
export function stageStatusOf(job: WorkflowJob): StageStatus {
  if (job.status !== 'completed') return 'cancelled';
  switch (job.conclusion) {
    case 'success':
      return 'passed';
    case 'failure':
    case 'timed_out':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'cancelled';
  }
}

/**
 * 段階の結果を作る（純関数）。job の名前が必須段階の名前と同じものだけを読む。無い段階は載せない（missing は不合格）。
 * run 全体が成功でないのに必須段階が全部 passed の場合は合格にしない。
 */
export function stagesFromJobs(jobs: readonly WorkflowJob[], headSha: string, runConclusion: string | null): StageResult[] {
  const stages: StageResult[] = [];
  for (const job of jobs) {
    if (!(REQUIRED_STAGES as readonly string[]).includes(job.name)) continue;
    if (job.head_sha !== undefined && job.head_sha !== headSha) continue;
    stages.push({ stage: job.name, status: stageStatusOf(job), logRef: job.html_url ?? null });
  }
  if (runConclusion !== 'success' && stages.every((s) => s.status === 'passed')) {
    stages.push({ stage: REQUIRED_STAGES[0], status: 'cancelled', logRef: null });
  }
  return stages;
}

export function createGithubCiCollector(options: GithubCiCollectorOptions): GithubCiCollector {
  const base = assertApiUrlAllowed(options.apiUrl, options.nodeEnv).toString().replace(/\/$/, '');
  const minInterval = options.minPollIntervalMs ?? 30_000;
  const httpTimeoutMs = options.httpTimeoutMs ?? 30_000;
  const lastPoll = new Map<string, number>();

  /** 読めないときは null（次の工程でやり直す）。404 は 'missing'。3xx は追わない。 */
  async function read<T>(path: string): Promise<T | null | 'missing'> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'mirai-sf-devline',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(httpTimeoutMs),
        redirect: 'manual',
      });
    } catch {
      return null;
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return 'missing';
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    try {
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  const workflowBlob = async (repo: string, ref: string): Promise<string | null | 'missing'> => {
    const params = new URLSearchParams({ ref });
    const got = await read<{ sha?: unknown; type?: unknown }>(
      `/repos/${repo}/contents/${REAL_RUNNER_POLICY.ciWorkflowPath}?${params.toString()}`,
    );
    if (got === null || got === 'missing') return got;
    return typeof got.sha === 'string' && got.type === 'file' ? got.sha : null;
  };

  return {
    async collect(job, ctx) {
      const repo = job.target_repo_id;
      const headSha = job.head_sha;
      if (!headSha || !REPO_RE.test(repo)) return null;
      const last = lastPoll.get(job.id);
      if (last !== undefined && ctx.now.getTime() - last < minInterval) return null;
      lastPoll.set(job.id, ctx.now.getTime());

      const pr = job.work_state.pr as { number?: unknown } | undefined;
      const prNumber = typeof pr?.number === 'number' ? pr.number : null;
      const branch = typeof job.work_state.branch === 'string' ? job.work_state.branch : null;

      const params = new URLSearchParams({ head_sha: headSha, per_page: '100' });
      const listed = await read<{ workflow_runs?: WorkflowRun[] }>(`/repos/${repo}/actions/runs?${params.toString()}`);
      if (listed === null || listed === 'missing' || !Array.isArray(listed.workflow_runs)) return null;
      const runs = listed.workflow_runs
        .filter((r) => isEvidenceRun(r, { repo, headSha, branch, prNumber }))
        .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
      const run = runs[0];
      if (!run || run.status !== 'completed') return null;

      // 古い run の成功で判断しない。最新の run が終わるまで待つ。workflow の改変は結論より先に見る
      const [headBlob, baseBlob] = await Promise.all([workflowBlob(repo, headSha), workflowBlob(repo, job.base_sha)]);
      if (headBlob === null || baseBlob === null) return null;
      if (headBlob === 'missing' || baseBlob === 'missing' || headBlob !== baseBlob) {
        return {
          halt: {
            reason: 'policy_violation',
            detail: { rule: 'workflow_changed', headMissing: headBlob === 'missing', baseMissing: baseBlob === 'missing' },
          },
        };
      }

      const jobs: WorkflowJob[] = [];
      for (let page = 1; page <= 5; page += 1) {
        const got = await read<{ jobs?: WorkflowJob[] }>(
          `/repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
        );
        if (got === null || got === 'missing' || !Array.isArray(got.jobs)) return null;
        jobs.push(...got.jobs);
        if (got.jobs.length < 100) break;
      }
      const stages = stagesFromJobs(jobs, headSha, run.conclusion);
      const reportDigest = createHash('sha256')
        .update(JSON.stringify({ runId: run.id, attempt: run.run_attempt, headSha, stages }), 'utf8')
        .digest('hex');
      return {
        jobId: job.id,
        deliveryId: `github:${run.id}:${run.run_attempt}:${headSha}`,
        source: 'github',
        ciRunId: String(run.id),
        runSequence: Math.max(1, run.run_number),
        runAttempt: Math.max(1, run.run_attempt),
        headSha,
        stages,
        // AC と test ID の対応は CI の報告が無いので作らない。結果は「未確認」になる
        acResults: [],
        logRef: run.html_url,
        reportDigest,
        now: ctx.now,
        correlationId: ctx.correlationId,
      };
    },
  };
}
