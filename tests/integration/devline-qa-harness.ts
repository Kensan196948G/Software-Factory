/**
 * 開発ライン QA の共通部品。実装者の試験とは独立に、契約（docs/devline/api-contract.md）から書く。
 * 外部は OS 割当ポートのローカル fake GitHub だけ。時刻は引数で進め、sleep しない。
 * ここは *.test.ts ではないので単独では実行されない。
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { closePool, query } from '../../src/api/db.js';
import { getJobView, type DevlineDeps } from '../../src/api/devline-service.js';
import { createGithubIssueAdapter } from '../../src/api/issue-adapter.js';
import { hashPassword } from '../../src/api/password.js';
import type { Actor } from '../../src/api/service.js';
import { REQUIRED_STAGES } from '../../src/shared/devline.js';
import type {
  FakeScenario,
  IssueAdapter,
  JobView,
  RecordVerificationInput,
  RunnerAdapter,
  RunnerArtifact,
  RunnerInput,
  RunnerResult,
  StageResult,
  StageStatus,
} from '../../src/shared/devline.js';
import { createFakeRunner } from '../../src/worker/fake-runner.js';
import { runOnce, type WorkerOptions } from '../../src/worker/loop.js';
import { FAKE_REPO, FAKE_REPO_ID, startFakeGithub, type FakeGithub, type FakeResponder } from './fake-github-server.js';
import { authHeaders, loginAs, prepareTestDb, sampleRequest, truncateBusiness, type Authed } from './helpers.js';

export const QA_TOKEN = 'qa-dummy-token-not-a-secret';
export const APPROVE = { to: 'approved', signal: 'g', checklistAcknowledged: true, reason: '作り物の承認' };

export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface Harness {
  github: FakeGithub;
  app: FastifyInstance;
  auth: Authed;
  clock(): Date;
  advance(ms: number): void;
  adapter(): IssueAdapter;
  /** 書き込みの直前にだけ応答を差し込む（読み取りの override に消費されない）。 */
  armedAdapter(replies: FakeResponder[]): IssueAdapter;
  deps(over?: Partial<DevlineDeps>): DevlineDeps;
  actor(role: 'requester' | 'desk' | 'approver', isAdmin?: boolean): Actor;
  worker(scenario: FakeScenario, over?: Partial<WorkerOptions>): WorkerOptions;
  api(method: ApiMethod, url: string, payload?: unknown, as?: Authed): Promise<LightMyRequestResponse>;
  setRole(role: string, as?: Authed): Promise<void>;
  detail(id: string): Promise<any>;
  transition(id: string, body: Record<string, unknown>): Promise<void>;
  createRequest(overrides?: Record<string, unknown>): Promise<string>;
  toWait(id: string): Promise<void>;
  approvedRequest(overrides?: Record<string, unknown>): Promise<string>;
  /** 編集 → 再承認で版を上げる（承認後の編集で +1、再承認で +1）。 */
  reapprove(id: string, purpose: string): Promise<number>;
  orderVersion(id: string): Promise<number>;
  handoff(id: string, extra?: Record<string, unknown>): Promise<LightMyRequestResponse>;
  intents(id: string): Promise<any[]>;
  events(jobId: string): Promise<any[]>;
  jobRow(jobId: string): Promise<any>;
  view(jobId: string): Promise<JobView>;
  count(sql: string, params?: unknown[]): Promise<number>;
  posts(): number;
  writes(): number;
  /** verifying まで worker で進める。 */
  untilVerifying(id: string): Promise<{ jobId: string; headSha: string }>;
  /** pr_ready まで worker で進める。 */
  untilPrReady(id: string): Promise<{ jobId: string; headSha: string }>;
  delivery(jobId: string, headSha: string, over?: Partial<RecordVerificationInput>): RecordVerificationInput;
}

let serial = 0;

export function stages(over: Record<string, StageStatus | 'missing'> = {}, failedTestIds: readonly string[] = []): StageResult[] {
  const rows: StageResult[] = [];
  for (const stage of REQUIRED_STAGES) {
    const status = over[stage] ?? 'passed';
    if (status === 'missing') continue;
    rows.push({ stage, status, ...(status === 'failed' ? { failedTestIds } : {}) });
  }
  return rows;
}

export function useHarness(options: { checkExternal?: boolean } = {}): Harness {
  let clockMs = Date.parse('2026-11-01T00:00:00Z');
  const h = {} as Harness;

  h.clock = () => new Date(clockMs);
  h.advance = (ms) => {
    clockMs += ms;
  };
  h.adapter = () => createGithubIssueAdapter({ token: QA_TOKEN, apiUrl: h.github.url, nodeEnv: 'test' });
  h.armedAdapter = (replies) => {
    const real = h.adapter();
    const arm = (): void => {
      const reply = replies.shift();
      if (reply) h.github.overrides.push(reply);
    };
    return {
      ...real,
      createIssue: async (input) => {
        arm();
        return real.createIssue(input);
      },
      updateIssue: async (input) => {
        arm();
        return real.updateIssue(input);
      },
    };
  };
  h.deps = (over = {}) => ({
    issueAdapter: h.adapter(),
    targetRepo: FAKE_REPO,
    allowedRepos: [{ name: FAKE_REPO, repoId: FAKE_REPO_ID }],
    now: h.clock,
    httpTimeoutMs: 2000,
    ...over,
  });
  h.actor = (role, isAdmin = false) => {
    const user = { id: h.auth.user.id, actingRole: role, displayName: 'テスト 太郎', isAdmin } as unknown as Actor['user'];
    return { user, userId: h.auth.user.id, role, displayName: 'テスト 太郎' };
  };
  h.worker = (scenario, over = {}) => ({
    owner: 'qa-worker',
    runner: createFakeRunner(scenario),
    scenario,
    clock: h.clock,
    allowedRepos: [{ name: FAKE_REPO, repoId: FAKE_REPO_ID }],
    tick: () => new Promise<void>(() => undefined),
    ...over,
  });
  h.api = async (method, url, payload, as) =>
    h.app.inject({
      method,
      url,
      headers: authHeaders(as ?? h.auth),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  h.setRole = async (role, as) => {
    const res = await h.api('POST', '/api/auth/role', { role }, as);
    expect(res.statusCode, res.body).toBe(200);
  };
  h.detail = async (id) => (await h.api('GET', `/api/requests/${id}`)).json().request;
  h.transition = async (id, body) => {
    const current = await h.detail(id);
    const res = await h.api('POST', `/api/requests/${id}/transitions`, { version: current.version, ...body });
    expect(res.statusCode, res.body).toBe(200);
  };
  h.createRequest = async (overrides = {}) => {
    await h.setRole('requester');
    serial += 1;
    const created = await h.api(
      'POST',
      '/api/requests',
      sampleRequest({ approver: 'テスト 太郎', title: `QA 依頼 ${serial}`, ...overrides }),
    );
    expect(created.statusCode, created.body).toBe(201);
    await h.setRole('desk');
    return created.json().request.id as string;
  };
  h.toWait = async (id) => {
    await h.transition(id, { to: 'review' });
    await h.transition(id, { to: 'wait' });
  };
  h.approvedRequest = async (overrides = {}) => {
    const id = await h.createRequest(overrides);
    await h.toWait(id);
    await h.setRole('approver');
    await h.transition(id, APPROVE);
    await h.setRole('desk');
    return id;
  };
  h.reapprove = async (id, purpose) => {
    const current = await h.detail(id);
    const edit = await h.api('PATCH', `/api/requests/${id}`, {
      ...sampleRequest({ approver: 'テスト 太郎', title: current.title, purpose }),
      version: current.version,
    });
    expect(edit.statusCode, edit.body).toBe(200);
    await h.setRole('approver');
    await h.transition(id, APPROVE);
    await h.setRole('desk');
    return h.orderVersion(id);
  };
  h.orderVersion = async (id) => (await h.detail(id)).orderVersion as number;
  h.handoff = async (id, extra = {}) =>
    h.api('POST', `/api/orders/${id}/handoff`, { orderVersion: await h.orderVersion(id), ...extra });
  h.intents = async (id) => (await query('select * from handoff_intent where request_id=$1 order by order_version', [id])).rows;
  h.events = async (jobId) => (await query('select * from job_event where job_id=$1 order by id', [jobId])).rows;
  h.jobRow = async (jobId) => (await query('select * from job where id=$1', [jobId])).rows[0];
  h.view = async (jobId) => (await getJobView(jobId)) as JobView;
  h.count = async (sql, params = []) => (await query<{ c: number }>(`select count(*)::int as c ${sql}`, params)).rows[0]?.c ?? -1;
  h.posts = () => h.github.access.filter((a) => a.method === 'POST').length;
  h.writes = () => h.github.access.filter((a) => a.method !== 'GET').length;
  h.untilVerifying = async (id) => {
    const res = await h.handoff(id);
    expect(res.statusCode, res.body).toBe(200);
    const jobId = res.json().jobId as string;
    const options = h.worker('success');
    await runOnce(options);
    await runOnce(options);
    await runOnce(options);
    const job = await h.view(jobId);
    expect(job.state).toBe('verifying');
    return { jobId, headSha: job.headSha as string };
  };
  h.untilPrReady = async (id) => {
    const { jobId, headSha } = await h.untilVerifying(id);
    await runOnce(h.worker('success'));
    expect((await h.view(jobId)).state).toBe('pr_ready');
    return { jobId, headSha };
  };
  h.delivery = (jobId, headSha, over = {}) => {
    serial += 1;
    return {
      jobId,
      deliveryId: `qa-d-${serial}`,
      source: 'fake_ci',
      ciRunId: `qa-run-${serial}`,
      runSequence: 1,
      runAttempt: 1,
      headSha,
      stages: stages(),
      acResults: [
        { acId: 'AC-1', testIds: ['qa.ac1'], status: 'passed' },
        { acId: 'AC-2', testIds: ['qa.ac2'], status: 'passed' },
      ],
      now: h.clock(),
      correlationId: 'qa',
      ...over,
    };
  };

  beforeAll(async () => {
    h.github = await startFakeGithub();
    await prepareTestDb();
    h.app = await buildApp({ serveStatic: false, devlineDeps: h.deps() });
    await h.app.ready();
  });

  afterAll(async () => {
    await h.app.close();
    await h.github.close();
    await closePool();
  });

  beforeEach(async () => {
    await truncateBusiness();
    await prepareTestDb();
    h.github.access.length = 0;
    h.github.issues.length = 0;
    h.github.overrides.length = 0;
    h.github.onWrite = null;
    h.auth = await loginAs(h.app);
  });

  afterEach(() => {
    if (options.checkExternal === false) return;
    // どの試験でも search API と PR の API を呼ばない（T-34, T-88）。token は fake サーバにしか届かない
    for (const access of h.github.access) {
      expect(access.path.startsWith('/search'), access.path).toBe(false);
      expect(access.path.includes('/pulls'), access.path).toBe(false);
      expect(access.authorization).toBe(`Bearer ${QA_TOKEN}`);
    }
  });

  return h;
}

/** 依頼者だけ、など役割を絞った利用者を作ってログインする（TEST_MEMBER は approver も持つので否定試験に足りない）。 */
export async function loginWithRoles(app: FastifyInstance, email: string, roles: string[], isAdmin = false): Promise<Authed> {
  const password = 'qa-pass-1234-not-a-secret';
  const existing = await query<{ id: string }>('select id from app_user where email=$1', [email]);
  if (!existing.rows[0]) {
    const hash = await hashPassword(password);
    const inserted = await query<{ id: string }>(
      `insert into app_user (email, display_name, dept_code, password_hash, is_admin) values ($1,$2,'dx',$3,$4) returning id`,
      [email, `QA ${roles.join('+')}`, hash, isAdmin],
    );
    for (const role of roles) {
      await query('insert into user_role (user_id, role) values ($1,$2)', [inserted.rows[0]?.id, role]);
    }
  }
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { csrf: string; user: { id: string } };
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  return { cookie: cookies.map((c) => c.split(';')[0]).join('; '), csrf: body.csrf, user: body.user };
}

/** 差し替え用の runner。各工程の結果を試験が決める。 */
export function scriptedRunner(
  behave: (input: RunnerInput) => Partial<RunnerResult> | Promise<Partial<RunnerResult>>,
): RunnerAdapter & { cancelCalls: { jobId: string; attemptNo: number }[]; runs: RunnerInput[] } {
  const cancelCalls: { jobId: string; attemptNo: number }[] = [];
  const runs: RunnerInput[] = [];
  return {
    capability: { kind: 'fake', isolation: 'none', network: 'none', supportsCancel: true, costAccounting: 'fake_zero' },
    cancelCalls,
    runs,
    async cancel(run) {
      cancelCalls.push(run);
    },
    async run(input) {
      runs.push(input);
      const extra = await behave(input);
      return {
        status: 'succeeded',
        exitCode: 0,
        headSha: input.step === 'plan' ? null : 'c'.repeat(39) + (input.attemptNo % 10).toString(),
        changedPaths: input.step === 'plan' ? [] : ['src/generated/qa.ts'],
        artifacts: [] as readonly RunnerArtifact[],
        logRef: null,
        usage: { inputTokens: 0, outputTokens: 0, durationSeconds: 0, costJpy: 0 },
        summary: 'qa',
        ...(input.step === 'plan' ? { plan: { steps: ['qa'] } } : {}),
        ...extra,
      };
    },
  };
}

/** DB の障害を注入する。試験の間だけトリガを置く（_test DB のみ）。 */
export async function withDbFault<T>(
  ddl: { table: string; when: string; timing?: 'before' | 'after' },
  fn: () => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: migrationUrl() });
  await client.connect();
  const name = `qa_fault_${ddl.table}`;
  try {
    await client.query(
      `create or replace function qa_fault_raise() returns trigger as $$ begin raise exception 'qa_injected_fault'; end; $$ language plpgsql`,
    );
    await client.query(
      `create trigger ${name} ${ddl.timing ?? 'before'} ${ddl.when} on ${ddl.table} for each row execute function qa_fault_raise()`,
    );
    return await fn();
  } finally {
    await client.query(`drop trigger if exists ${name} on ${ddl.table}`);
    await client.end();
  }
}

export function migrationUrl(): string {
  const url = process.env.TEST_MIGRATION_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL が未設定です');
  if (!/_test$/.test(new URL(url).pathname)) throw new Error('QA の試験は _test DB でのみ実行します');
  return url;
}

export function testDbUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? migrationUrl();
  if (!/_test$/.test(new URL(url).pathname)) throw new Error('QA の試験は _test DB でのみ実行します');
  return url;
}

/** リポジトリの node_modules の tsx でスクリプトを別プロセスで動かす。接続先は _test に固定する。 */
export function runScript(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((done, fail) => {
    const child = spawn(resolve(process.cwd(), 'node_modules/.bin/tsx'), args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: testDbUrl(),
        MIGRATION_DATABASE_URL: migrationUrl(),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    child.on('error', fail);
    child.on('close', (code) => done({ code, out }));
  });
}
