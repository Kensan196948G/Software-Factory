import { expect, test as base, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 承認プロセス E2E の共通フィクスチャ。
 *
 * 役割は 2 つだけ（管理者=approver のみ / 一般利用者=requester のみ）。
 * 層①はパスワードで作った storageState、層②③は人間が OTP でログインした storageState を使う。
 * テストは 2 役のブラウザコンテキストを切り替えて進める（ログインは 1 ラウンド 1 回）。
 *
 * 5xx と pageerror は 0 件でなければならない（docs/production/51-approval-e2e-*.md）。
 * 4xx は監査・拒否の実測値として記録するだけで、失敗にはしない。
 */

export type Layer = 'iso' | 'otp' | 'prod';
export const LAYER = (process.env.E2E_LAYER ?? 'iso') as Layer;
export const IS_ISO = LAYER === 'iso';
export const IS_OTP = LAYER === 'otp';
export const IS_PROD = LAYER === 'prod';

/** 実行ごとに一意な接尾辞。件名に付けて、前回・並行実行のデータと取り違えない。 */
export const RUN_ID = (process.env.E2E_RUN_ID ?? `${Date.now().toString(36)}`).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 16);

/** 本番で使う日付（Asia/Tokyo）。 */
export const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());

export const AUTH_DIR = process.env.E2E_AUTH_DIR ?? join(homedir(), '.config', 'mirai-sf', 'e2e-auth');
export const ADMIN_STATE = process.env.E2E_ADMIN_STATE ?? join(AUTH_DIR, 'admin.json');
export const USER_STATE = process.env.E2E_USER_STATE ?? join(AUTH_DIR, 'user.json');
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? '';
export const USER_EMAIL = process.env.E2E_USER_EMAIL ?? '';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
export const USER_PASSWORD = process.env.E2E_USER_PASSWORD ?? '';
export const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? join('test-results', 'approval');

/** 本番で作る依頼の件名。層②③はこの形で始める。 */
export function requestTitle(slug: string): string {
  const prefix = IS_PROD ? `【検証】${TODAY}` : `E2E ${TODAY} ${RUN_ID}`;
  return `${prefix} ${slug}`;
}

export interface RecordedHttp {
  status: number;
  method: string;
  url: string;
}

export interface Recorder {
  http: RecordedHttp[];
  pageErrors: string[];
  consoleErrors: string[];
  notes: Record<string, unknown>;
}

export interface ApiResult {
  status: number;
  body: any;
  text: string;
}

export interface Api {
  call(method: string, path: string, data?: unknown): Promise<ApiResult>;
  get(path: string): Promise<ApiResult>;
  post(path: string, data?: unknown): Promise<ApiResult>;
  patch(path: string, data?: unknown): Promise<ApiResult>;
  del(path: string): Promise<ApiResult>;
}

function makeApi(context: BrowserContext): Api {
  let csrf: string | null = null;
  const token = async (): Promise<string> => {
    if (csrf) return csrf;
    const res = await context.request.get('/api/auth/csrf', { timeout: 30_000 });
    expect(res.status(), 'CSRF トークンを取得できません（セッションが無効の可能性）').toBe(200);
    csrf = String(((await res.json()) as { csrf?: string }).csrf ?? '');
    expect(csrf, 'CSRF トークンが空です').not.toBe('');
    return csrf;
  };
  const call = async (method: string, path: string, data?: unknown): Promise<ApiResult> => {
    const headers = method === 'GET' ? undefined : { 'x-csrf-token': await token() };
    const res = await context.request.fetch(path, {
      method,
      headers,
      ...(data === undefined ? {} : { data: data as never }),
      timeout: 60_000,
      failOnStatusCode: false,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status(), body, text };
  };
  return {
    call,
    get: (path) => call('GET', path),
    post: (path, data) => call('POST', path, data),
    patch: (path, data) => call('PATCH', path, data),
    del: (path) => call('DELETE', path),
  };
}

export interface Evidence {
  note: (key: string, value: unknown) => void;
}

export interface FakeGithubControl {
  state: () => Promise<any>;
  issues: () => Promise<any[]>;
  addPull: (input: {
    number: number;
    head: string;
    body: string;
    login?: string;
    state?: 'open' | 'closed';
    merged?: boolean;
    trees?: Record<string, string>;
  }) => Promise<any>;
}

export interface RoleSession {
  context: BrowserContext;
  page: Page;
  api: Api;
}

interface Fixtures {
  recorder: Recorder;
  evidence: Evidence;
  admin: RoleSession;
  user: RoleSession;
  db: { query: (sql: string, params?: unknown[]) => Promise<any> } | null;
  fake: FakeGithubControl | null;
}

function attachRecorder(context: BrowserContext, page: Page, rec: Recorder): void {
  context.on('response', (response) => {
    const status = response.status();
    if (status >= 400) {
      rec.http.push({ status, method: response.request().method(), url: response.url() });
    }
  });
  page.on('pageerror', (error) => {
    rec.pageErrors.push(error.message);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') rec.consoleErrors.push(msg.text());
  });
}

async function openRole(
  browser: Browser,
  statePath: string,
  role: 'approver' | 'requester',
  rec: Recorder,
): Promise<RoleSession> {
  if (!existsSync(statePath)) {
    throw new Error(
      `storageState がありません: ${statePath}（層①は env/run-iso.ts、層②③は env/otp-login.ts で作成してください）`,
    );
  }
  const context = await browser.newContext({
    storageState: statePath,
    locale: 'ja-JP',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  attachRecorder(context, page, rec);
  const api = makeApi(context);
  const me = await api.get('/api/auth/me');
  expect(me.status, `ログイン中のセッションが無効です（${role}）`).toBe(200);
  const actingRole = String(me.body?.user?.actingRole ?? '');
  if (actingRole !== role) {
    const switched = await api.post('/api/auth/role', { role });
    expect(switched.status, `操作する人を ${role} に切り替えられません`).toBe(200);
  }
  // 前回のサーバ側下書きを持ち越さない（新規依頼の「書きかけがあります」を出さない）。
  await api.del('/api/drafts');
  return { context, page, api };
}

function sanitize(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^a-zA-Z0-9\u3040-\u30ff\u4e00-\u9fff.-]/g, '')
    .slice(0, 120);
}

export const test = base.extend<Fixtures>({
  // すべてのテストで 5xx / pageerror を数え、証跡（JSON）を残す自動フィクスチャ。
  recorder: [
    async ({}, use, testInfo) => {
      const rec: Recorder = { http: [], pageErrors: [], consoleErrors: [], notes: {} };
      await use(rec);
      mkdirSync(join(EVIDENCE_DIR, 'evidence'), { recursive: true });
      const file = join(
        EVIDENCE_DIR,
        'evidence',
        `${String(testInfo.workerIndex)}-${sanitize(testInfo.titlePath.join('__'))}.json`,
      );
      const record = {
        layer: LAYER,
        runId: RUN_ID,
        title: testInfo.title,
        titlePath: testInfo.titlePath,
        startedAt: new Date(Date.now() - testInfo.duration).toISOString(),
        durationMs: testInfo.duration,
        status: testInfo.status,
        notes: rec.notes,
        http4xx: rec.http.filter((x) => x.status < 500),
        http5xx: rec.http.filter((x) => x.status >= 500),
        pageErrors: rec.pageErrors,
        consoleErrors: rec.consoleErrors,
      };
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      expect(record.http5xx, '5xx を観測した（失敗として扱う）').toEqual([]);
      expect(record.pageErrors, 'JavaScript の例外（pageerror）を観測した').toEqual([]);
    },
    { auto: true },
  ],

  evidence: async ({ recorder }, use) => {
    const evidence: Evidence = { note: (key, value) => void (recorder.notes[key] = value) };
    await use(evidence);
  },

  admin: async ({ browser, recorder }, use) => {
    const session = await openRole(browser, ADMIN_STATE, 'approver', recorder);
    try {
      await use(session);
    } finally {
      await session.context.close();
    }
  },

  user: async ({ browser, recorder }, use) => {
    const session = await openRole(browser, USER_STATE, 'requester', recorder);
    try {
      await use(session);
    } finally {
      await session.context.close();
    }
  },

  db: async ({}, use) => {
    const url = process.env.E2E_DB_URL;
    if (!url) {
      await use(null);
      return;
    }
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    try {
      await use({ query: async (sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows });
    } finally {
      await pool.end();
    }
  },

  fake: async ({}, use) => {
    const base = process.env.E2E_FAKE_CONTROL_URL;
    if (!base) {
      await use(null);
      return;
    }
    const ctx = await (await import('@playwright/test')).request.newContext({ baseURL: base });
    const call = async (method: string, path: string, data?: unknown): Promise<any> => {
      const res = await ctx.fetch(path, {
        method,
        ...(data === undefined ? {} : { data: data as never }),
        failOnStatusCode: false,
      });
      expect(res.status(), `fake GitHub の制御 API が失敗: ${method} ${path}`).toBeLessThan(400);
      return res.json();
    };
    const control: FakeGithubControl = {
      state: () => call('GET', '/__ctl/state'),
      issues: async () => ((await call('GET', '/__ctl/state')) as { issues: any[] }).issues,
      addPull: (input) => call('POST', '/__ctl/pull', input),
    };
    try {
      await use(control);
    } finally {
      await ctx.dispose();
    }
  },
});

export { expect };
