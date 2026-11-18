/**
 * 承認プロセス E2E の層①（隔離環境）を丸ごと用意して実行する。
 *
 *   使い捨て DB を作る → migrate / seed → 2 アカウント作成 → 画面をビルド
 *   → 偽 GitHub（制御 API つき）を起動 → API を別ポートで起動
 *   → パスワードで storageState を 2 役分作る → Playwright（--project=iso）を実行
 *   → API 停止 → DB drop → storageState 削除
 *
 * 実行: pnpm -s exec tsx tests/e2e/approval/env/run-iso.ts -- --repeat-each=5
 * 引数はそのまま Playwright へ渡す（--project は付けない）。
 * 実データ・本番 DB・実 GitHub へは触らない。パスワードは環境変数だけに置き、出力しない。
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request } from '@playwright/test';
import { FAKE_REPO, FAKE_REPO_ID, startFakeGithubWithControl } from './fake-github-control';

interface Child {
  kill: (signal?: NodeJS.Signals) => boolean;
  exitCode: number | null;
  once: (event: string, cb: (...args: any[]) => void) => void;
}

const root = process.cwd();
const evidenceDir = process.env.E2E_EVIDENCE_DIR ?? join(root, 'test-results', 'approval');
const stamp = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})
  .format(new Date())
  .replace(/[-: ]/g, '');
const runId = stamp;
const dbName = `mirai_sf_approval_e2e_${stamp}_${randomBytes(3).toString('hex')}`;
const dbUrl = `postgresql:///${dbName}?host=/var/run/postgresql`;
const adminEmail = (process.env.E2E_ADMIN_EMAIL ?? '').trim();
const userEmail = (process.env.E2E_USER_EMAIL ?? '').trim();
const adminPassword = randomBytes(24).toString('base64url');
const userPassword = randomBytes(24).toString('base64url');
const rawArgs = process.argv.slice(2);
// `pnpm exec tsx ... -- --grep X` の区切り `--` を Playwright へ渡さない。
const playwrightArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
const keepDb = process.env.E2E_KEEP_DB === '1';

if (!adminEmail || !userEmail) {
  console.error('E2E_ADMIN_EMAIL / E2E_USER_EMAIL を環境変数で渡してください（リポジトリ・ログには書かない）');
  process.exit(2);
}

interface IsoEvidence {
  startedAt: string;
  runId: string;
  layer: string;
  db: string;
  playwrightArgs: string[];
  steps: { at: string; name: string; ok: boolean; detail?: string }[];
  usersActive: number | null;
  apiUrl?: string;
  dbVerify?: boolean;
}
const evidence: IsoEvidence = {
  startedAt: new Date().toISOString(),
  runId,
  layer: 'iso',
  db: dbName,
  playwrightArgs,
  steps: [],
  usersActive: null,
};
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(join(evidenceDir, 'logs'), { recursive: true });
const mailDir = join(evidenceDir, 'mail');
mkdirSync(mailDir, { recursive: true });

function stepNow(name: string, ok = true, detail?: string): void {
  evidence.steps.push({ at: new Date().toISOString(), name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? 'OK  ' : 'NG  '} ${name}${detail ? ` — ${detail}` : ''}`);
}

function runSync(command: string, args: string[], env: NodeJS.ProcessEnv, logName: string): string {
  const res = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 180_000 });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  writeFileSync(join(evidenceDir, 'logs', logName), output, 'utf8');
  if (res.status !== 0) {
    stepNow(`${command} ${args.join(' ')}`, false, `exit=${res.status}`);
    throw new Error(`${command} ${args.join(' ')} が失敗しました: ${output.slice(-1500)}`);
  }
  return output;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitFor(url: string, timeoutMs: number): Promise<any> {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`待機が時間切れ: ${url} (${lastError})`);
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * dist/web が src/web より新しければビルドしない。同時ビルドはロックで直列化する。
 * 画面の静的ファイル（public/ 配下）はすべて比較する。station.js だけを見ていると、
 * station-bridge.js のような他のファイルの変更を取りこぼし、古い配布物で試験してしまう。
 */
async function ensureWebBuilt(env: NodeJS.ProcessEnv): Promise<boolean> {
  const distDir = join(root, 'dist', 'web');
  const publicDir = join(root, 'src', 'web', 'public');
  const distIndex = join(distDir, 'index.html');
  const srcIndex = join(root, 'src', 'web', 'index.html');
  const fresh = (): boolean => {
    if (!existsSync(distIndex) || mtime(distIndex) < mtime(srcIndex)) return false;
    for (const name of readdirSync(publicDir)) {
      const dist = join(distDir, name);
      if (!existsSync(dist) || mtime(dist) < mtime(join(publicDir, name))) return false;
    }
    return true;
  };
  if (fresh()) return false;
  const lock = join(root, 'test-results', '.e2e-build-web.lock');
  mkdirSync(join(root, 'test-results'), { recursive: true });
  const started = Date.now();
  let acquired = false;
  while (Date.now() - started < 180_000) {
    try {
      mkdirSync(lock);
      acquired = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!acquired) throw new Error('画面ビルドのロックを取得できませんでした（他の層①実行が長引いています）');
  try {
    if (fresh()) return false;
    runSync('pnpm', ['-s', 'run', 'build:web'], env, 'build-web.log');
    return true;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

async function createStateFile(apiUrl: string, email: string, password: string, path: string): Promise<number> {
  const context = await request.newContext({ baseURL: apiUrl });
  try {
    const login = await context.post('/api/auth/login', { data: { email, password } });
    if (login.status() !== 200) throw new Error(`ログインできません（HTTP ${login.status()}）`);
    const me = await context.get('/api/auth/me');
    if (me.status() !== 200) throw new Error('ログイン後の /api/auth/me が失敗しました');
    await context.storageState({ path });
    chmodSync(path, 0o600);
    return login.status();
  } finally {
    await context.dispose();
  }
}

const children: Child[] = [];
let fake: Awaited<ReturnType<typeof startFakeGithubWithControl>> | null = null;
let api: Child | null = null;
let authDir = '';
let secretsDir = '';
let exitCode = 1;

try {
  mkdirSync(join(evidenceDir, 'logs'), { recursive: true });
  stepNow('使い捨て DB を作成', true, dbName);
  runSync('createdb', ['-h', '/var/run/postgresql', dbName], process.env, 'createdb.log');

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: dbUrl,
    NODE_ENV: 'test',
    APP_ENV: 'test',
    SEED_ADMIN_EMAIL: adminEmail,
    SEED_ADMIN_PASSWORD: adminPassword,
    SEED_ADMIN_NAME: '管理者',
    SEED_ADMIN_DEPT: 'dx',
  };

  runSync('pnpm', ['-s', 'exec', 'tsx', 'scripts/db.ts', 'migrate'], baseEnv, 'migrate.log');
  stepNow('migrate', true);
  runSync('pnpm', ['-s', 'exec', 'tsx', 'scripts/db.ts', 'seed'], baseEnv, 'seed.log');
  stepNow('seed', true);

  runSync(
    'pnpm',
    ['-s', 'exec', 'tsx', 'tests/e2e/approval/env/setup-users.mts'],
    {
      ...baseEnv,
      APPROVER_EMAIL: adminEmail,
      REQUESTER_EMAIL: userEmail,
      APPROVER_PASSWORD: adminPassword,
      REQUESTER_PASSWORD: userPassword,
    },
    'users-setup.log',
  );
  stepNow('2 アカウント作成（正規経路）', true);

  // 画面は HEAD のソースから作り直す（dist/web が古いと予行の意味が変わる）。
  // 並行実行で dist/web を同時に書かないよう、リポジトリ共通のロックを取り、
  // すでに最新ならビルドを省く（画面のソースは E2E では変えない）。
  const built = await ensureWebBuilt(baseEnv);
  stepNow(built ? '画面をビルド（dist/web）' : '画面は最新（ビルド省略）', true);

  fake = await startFakeGithubWithControl();
  stepNow('偽 GitHub を起動', true, `${FAKE_REPO}#${FAKE_REPO_ID} → ${fake.github.url}`);

  // merge の承認は API が資格情報ファイルから DEVLINE_GITHUB_TOKEN を読む（0600・リポジトリ外）。
  secretsDir = mkdtempSync(join(tmpdir(), 'sf-approval-e2e-'));
  const secretsPath = join(secretsDir, 'devline.env');
  writeFileSync(secretsPath, 'DEVLINE_GITHUB_TOKEN=e2e-dummy-token-not-a-secret\n', { mode: 0o600 });
  chmodSync(secretsPath, 0o600);

  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  evidence.apiUrl = apiUrl;
  const apiEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOST: '127.0.0.1',
    PORT: String(port),
    APP_BASE_URL: apiUrl,
    AUTH_MODE: 'password',
    ALLOW_SELF_APPROVAL: '0',
    COOKIE_SECURE: '0',
    REQUIRE_ORIGIN_SECRET: '0',
    SESSION_SECRET: randomBytes(32).toString('base64url'),
    MAIL_MODE: 'file',
    MAIL_OUTBOX_DIR: mailDir,
    MAIL_APPROVAL_TO: adminEmail,
    MAIL_FROM: 'no-reply@mirai-sf.local',
    GITHUB_TOKEN: 'e2e-dummy-token-not-a-secret',
    GITHUB_REPO: FAKE_REPO,
    GITHUB_API_URL: fake.github.url,
    DEVLINE_TARGET_REPOS: `${FAKE_REPO}:${FAKE_REPO_ID}`,
    DEVLINE_RUNNER_KIND: 'fake',
    DEVLINE_AUTO_MERGE: '0',
    DEVLINE_SECRETS_FILE: secretsPath,
  };
  const apiLog = join(evidenceDir, 'logs', 'api.log');
  const apiProcess = spawn(join(root, 'node_modules', '.bin', 'tsx'), ['src/api/server.ts'], {
    cwd: root,
    env: apiEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api = apiProcess as unknown as Child;
  children.push(api);
  const logStream = (await import('node:fs')).createWriteStream(apiLog, { flags: 'w' });
  apiProcess.stdout?.pipe(logStream);
  apiProcess.stderr?.pipe(logStream);

  const health = await waitFor(`${apiUrl}/healthz`, 90_000);
  evidence.usersActive = health.auth?.usersActive ?? null;
  if (health.status !== 'ok' || health.db?.ok !== true)
    throw new Error(`隔離 API が ready ではありません: ${JSON.stringify(health)}`);
  if (health.auth?.usersActive !== 2) throw new Error(`有効な利用者が 2 名ではありません: ${health.auth?.usersActive}`);
  stepNow('隔離 API を起動', true, `${apiUrl} usersActive=2`);

  authDir = join(homedir(), '.config', 'mirai-sf', 'e2e-auth', `iso-${runId}-${randomBytes(2).toString('hex')}`);
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const adminState = join(authDir, 'admin.json');
  const userState = join(authDir, 'user.json');
  await createStateFile(apiUrl, adminEmail, adminPassword, adminState);
  await createStateFile(apiUrl, userEmail, userPassword, userState);
  stepNow('storageState を 2 役分作成', true, '0600 / リポジトリ外');

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    E2E_LAYER: 'iso',
    E2E_BASE_URL: apiUrl,
    E2E_AUTH_DIR: authDir,
    E2E_ADMIN_STATE: adminState,
    E2E_USER_STATE: userState,
    E2E_ADMIN_EMAIL: adminEmail,
    E2E_USER_EMAIL: userEmail,
    E2E_ADMIN_PASSWORD: adminPassword,
    E2E_USER_PASSWORD: userPassword,
    E2E_EVIDENCE_DIR: evidenceDir,
    E2E_DB_URL: dbUrl,
    E2E_FAKE_CONTROL_URL: fake.controlUrl,
    E2E_RUN_ID: runId,
    E2E_DATE: today,
    E2E_HEADED: '0',
  };

  const args = ['-s', 'exec', 'playwright', 'test', '-c', 'playwright.approval.config.ts', '--project=iso', ...playwrightArgs];
  const pw = spawn('pnpm', args, { cwd: root, env, stdio: 'inherit' });
  children.push(pw as unknown as Child);
  exitCode = await new Promise<number>((resolve) => pw.once('exit', (code: number | null) => resolve(code ?? 1)));
  stepNow('Playwright（層①）', exitCode === 0, `exit=${exitCode}`);

  // 監査ハッシュ連鎖の最終確認（テスト本体でも A12 が実行する。ここでは全体の後片付け前にもう一度）。
  try {
    const verify = runSync('pnpm', ['-s', 'exec', 'tsx', 'scripts/db.ts', 'verify'], baseEnv, 'db-verify-final.log');
    evidence.dbVerify = /verify 成功/.test(verify);
  } catch {
    evidence.dbVerify = false;
  }
} catch (error) {
  stepNow('実行', false, String(error).slice(0, 800));
  exitCode = exitCode === 0 ? 1 : exitCode;
} finally {
  const cleanup: string[] = [];
  if (api) {
    api.kill('SIGTERM');
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      api!.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) api.kill('SIGKILL');
    cleanup.push(`api stopped (${exited ? 'SIGTERM' : 'SIGKILL'})`);
  }
  if (fake) {
    await fake.close().catch(() => undefined);
    cleanup.push('fake github stopped');
  }
  if (!keepDb) {
    const drop = spawnSync('dropdb', ['-h', '/var/run/postgresql', '--if-exists', dbName], { encoding: 'utf8' });
    cleanup.push(`db dropped (exit=${drop.status})`);
  } else {
    cleanup.push('db kept (E2E_KEEP_DB=1)');
  }
  if (authDir && existsSync(authDir)) {
    rmSync(authDir, { recursive: true, force: true });
    cleanup.push('storageState removed');
  }
  if (secretsDir && existsSync(secretsDir)) {
    rmSync(secretsDir, { recursive: true, force: true });
    cleanup.push('devline secrets removed');
  }
  writeFileSync(
    join(evidenceDir, 'iso-summary.json'),
    `${JSON.stringify({ ...evidence, endedAt: new Date().toISOString(), cleanup }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\n層①の後片付け: ${cleanup.join(' / ')}`);
}

process.exit(exitCode);
