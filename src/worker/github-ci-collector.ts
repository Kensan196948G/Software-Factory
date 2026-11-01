/**
 * 独立 CI の結果の収集（GitHub Actions）。合否の根拠は Actions の記録だけ。ランナーの自己申告を使わない。
 *
 * 証拠として認める run の条件: head SHA・workflow の path・event・リポジトリ・PR の head が一致すること。
 * workflow ファイルが base と同じ blob でなければ policy_violation で止める（AI が弱めた workflow を受け入れない）。
 * 読むのは Actions（Read）と Contents（Read）の範囲。再実行は要求しない。
 *
 * 受入条件の結果は同じ run の artifact `ac-results` だけから読む。読めない（通信の失敗）ときはやり直し、
 * 無い・期限切れ・大きすぎる・形が違う・repository／run／attempt／head が取得元と違う・AC ID の重複／未知／欠落は
 * 「証跡の欠落」として記録し、合格にしない。PR 本文や AI の申告からは作らない。
 */
import { createHash } from 'node:crypto';
import { assertApiUrlAllowed } from '../api/issue-adapter.js';
import { REAL_RUNNER_POLICY, REQUIRED_STAGES } from '../shared/devline.js';
import type { AcResult, RecordVerificationInput, StageResult, StageStatus, StopReason } from '../shared/devline.js';
import {
  AC_ARTIFACT_MAX_BYTES,
  AC_ARTIFACT_NAME,
  parseAcResults,
  readSingleJsonFromZip,
  type AcArtifactProblem,
} from './ac-artifact.js';

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
  /** この試行の開始時刻。前の試行の artifact を使わないために見る。 */
  run_started_at?: string | null;
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

interface WorkflowArtifact {
  id: number;
  name: string;
  size_in_bytes?: number;
  expired?: boolean;
  created_at?: string | null;
  workflow_run?: { id?: number; head_sha?: string } | null;
}

/** ok: 読めた / problem: 証跡の欠落（記録して止まる）/ retry: 通信の失敗（記録せず次の工程でやり直す）。 */
type AcRead =
  | { kind: 'ok'; results: AcResult[]; digest: string; problem: 'missing_ac_id' | null }
  | { kind: 'problem'; problem: AcArtifactProblem }
  | { kind: 'retry' };

/** run の artifact から使うものを選ぶ（純関数）。同じ名前の別 run のものと、同じ run の前の試行のものは使わない。 */
export function selectAcArtifact(
  artifacts: readonly WorkflowArtifact[],
  run: { id: number; head_sha: string; run_started_at?: string | null },
): { ok: true; artifact: WorkflowArtifact } | { ok: false; problem: AcArtifactProblem } {
  const sameName = artifacts.filter((a) => a.name === AC_ARTIFACT_NAME);
  if (sameName.length === 0) return { ok: false, problem: 'missing' };
  const named = sameName.filter((a) => a.workflow_run?.id === run.id);
  if (named.length === 0) return { ok: false, problem: 'run_mismatch' };
  if (named.some((a) => a.workflow_run?.head_sha !== run.head_sha)) return { ok: false, problem: 'head_mismatch' };
  const startedAt = Date.parse(run.run_started_at ?? '');
  const current = Number.isNaN(startedAt) ? named : named.filter((a) => !(Date.parse(a.created_at ?? '') < startedAt));
  const [artifact, ...rest] = current;
  if (!artifact) return { ok: false, problem: 'missing' };
  if (rest.length > 0) return { ok: false, problem: 'duplicate' };
  if (artifact.expired === true) return { ok: false, problem: 'expired' };
  if (!Number.isSafeInteger(artifact.id)) return { ok: false, problem: 'invalid' };
  if ((artifact.size_in_bytes ?? 0) > AC_ARTIFACT_MAX_BYTES) return { ok: false, problem: 'too_large' };
  return { ok: true, artifact };
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

/** 必須段階の名前に合わない job（純関数）。段階名の不一致を止める理由に載せる。 */
export function unmatchedJobNames(jobs: readonly WorkflowJob[]): string[] {
  return jobs
    .map((job) => String(job.name).slice(0, 100))
    .filter((name) => !(REQUIRED_STAGES as readonly string[]).includes(name))
    .slice(0, 50);
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

  /** 上限を超えたら読むのをやめる。content-length は信用しない。 */
  async function readCapped(res: Response): Promise<Buffer | 'too_large'> {
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      size += value.length;
      if (size > AC_ARTIFACT_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return 'too_large';
      }
      chunks.push(Buffer.from(value));
    }
  }

  /**
   * zip を取得する。GitHub は署名つきの保管先の URL へ 302 で返すので、1回だけ自分で追う。
   * 追う先へ token を送らない。追う先は API の接続先と同じ規則（https。試験ではループバックだけ）で確かめる。
   */
  async function downloadZip(repo: string, id: number): Promise<Buffer | { problem: AcArtifactProblem } | 'retry'> {
    const statusProblem = async (res: Response): Promise<{ problem: AcArtifactProblem } | 'retry'> => {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 404) return { problem: 'missing' };
      if (res.status === 410) return { problem: 'expired' };
      return 'retry';
    };
    try {
      const first = await fetch(`${base}/repos/${repo}/actions/artifacts/${id}/zip`, {
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
      let res = first;
      if (first.status >= 300 && first.status < 400) {
        await first.body?.cancel().catch(() => undefined);
        const location = first.headers.get('location');
        if (!location) return { problem: 'invalid' };
        let target: URL;
        try {
          target = assertApiUrlAllowed(location, options.nodeEnv);
        } catch {
          return { problem: 'invalid' };
        }
        res = await fetch(target, {
          method: 'GET',
          headers: { 'user-agent': 'mirai-sf-devline' },
          signal: AbortSignal.timeout(httpTimeoutMs),
          redirect: 'manual',
        });
      }
      if (!res.ok) return await statusProblem(res);
      const body = await readCapped(res);
      return body === 'too_large' ? { problem: 'too_large' } : body;
    } catch {
      return 'retry';
    }
  }

  async function readAcArtifact(repo: string, run: WorkflowRun, acIds: readonly string[]): Promise<AcRead> {
    const params = new URLSearchParams({ name: AC_ARTIFACT_NAME, per_page: '100' });
    const listed = await read<{ artifacts?: WorkflowArtifact[] }>(
      `/repos/${repo}/actions/runs/${run.id}/artifacts?${params.toString()}`,
    );
    if (listed === null) return { kind: 'retry' };
    if (listed === 'missing') return { kind: 'problem', problem: 'missing' };
    if (!Array.isArray(listed.artifacts)) return { kind: 'retry' };
    const selected = selectAcArtifact(listed.artifacts, run);
    if (!selected.ok) return { kind: 'problem', problem: selected.problem };
    const zip = await downloadZip(repo, selected.artifact.id);
    if (zip === 'retry') return { kind: 'retry' };
    if (!Buffer.isBuffer(zip)) return { kind: 'problem', problem: zip.problem };
    const raw = readSingleJsonFromZip(zip);
    if (!raw) return { kind: 'problem', problem: 'invalid' };
    const parsed = parseAcResults(raw, {
      repository: repo,
      runId: run.id,
      runAttempt: run.run_attempt,
      headSha: run.head_sha,
      acIds,
    });
    if (!parsed.ok) return { kind: 'problem', problem: parsed.problem };
    return {
      kind: 'ok',
      results: parsed.results,
      digest: createHash('sha256').update(raw).digest('hex'),
      problem: parsed.missingAcIds.length > 0 ? 'missing_ac_id' : null,
    };
  }

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
      // 通信の失敗では記録しない。delivery は run ごとに1回なので、記録すると欠落のまま固定される
      const ac = await readAcArtifact(repo, run, ctx.acIds);
      if (ac.kind === 'retry') return null;
      const acResults = ac.kind === 'ok' ? ac.results : [];
      const acDigest = ac.kind === 'ok' ? ac.digest : null;
      const reportDigest = createHash('sha256')
        .update(JSON.stringify({ runId: run.id, attempt: run.run_attempt, headSha, stages, acDigest }), 'utf8')
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
        acResults,
        logRef: run.html_url,
        reportDigest,
        diagnostics: {
          runConclusion: run.conclusion,
          unmatchedJobs: unmatchedJobNames(jobs),
          acArtifact: ac.problem ?? 'ok',
        },
        now: ctx.now,
        correlationId: ctx.correlationId,
      };
    },
  };
}
