/**
 * 層②③（Cloudflare Access の OTP）のラウンド実行。
 *
 * 前提: 人間が `otp-login.ts` を実行し、2 役ぶんの storageState を
 *       ~/.config/mirai-sf/e2e-auth/{admin,user}.json（0600）に保存していること。
 * このスクリプトは OTP を受け取らない・入力しない。ログインもしない。
 *
 * 実行:
 *   E2E_BASE_URL=https://sf.mirai-dx-platform.com E2E_LAYER=otp \
 *     pnpm -s exec tsx tests/e2e/approval/env/run-otp.ts
 *   E2E_BASE_URL=https://sf-prod.mirai-dx-platform.com E2E_LAYER=prod \
 *     pnpm -s exec tsx tests/e2e/approval/env/run-otp.ts
 *
 * ログアウト（A11）はラウンドの最後に 1 回だけ。A11 が共有 storageState を失効させるため、
 * 先に全テスト（@logout-last 以外）を通し、成功したときだけ A11 を実行する。
 * 失敗したら storageState を消さずに残す（OTP を取り直さずに影響範囲だけ再実行できるようにする）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const rawLayer = process.env.E2E_LAYER ?? 'otp';
if (!['otp', 'prod'].includes(rawLayer)) {
  console.error('E2E_LAYER は otp か prod を指定してください');
  process.exit(2);
}
const layer = rawLayer as 'otp' | 'prod';
const project = layer === 'prod' ? 'prod-smoke' : 'otp';
const baseUrl = (process.env.E2E_BASE_URL ?? '').trim().replace(/\/$/, '');
const allowAny = process.env.E2E_ALLOW_ANY_BASE === '1';
const expectedHost = layer === 'prod' ? 'sf-prod.mirai-dx-platform.com' : 'sf.mirai-dx-platform.com';
if (!baseUrl) {
  console.error('E2E_BASE_URL が必要です（例: https://sf.mirai-dx-platform.com）');
  process.exit(2);
}
if (!allowAny && !baseUrl.includes(expectedHost)) {
  console.error(
    `E2E_BASE_URL が層${layer === 'prod' ? '③' : '②'}の宛先ではありません（${expectedHost}）。誤爆防止のため中止します。`,
  );
  process.exit(2);
}

const authDir = process.env.E2E_AUTH_DIR ?? join(homedir(), '.config', 'mirai-sf', 'e2e-auth');
const adminState = process.env.E2E_ADMIN_STATE ?? join(authDir, 'admin.json');
const userState = process.env.E2E_USER_STATE ?? join(authDir, 'user.json');
const evidenceDir = process.env.E2E_EVIDENCE_DIR ?? join(root, 'test-results', `approval-${layer}`);
const logoutEvidenceDir = `${evidenceDir}-logout`;
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(logoutEvidenceDir, { recursive: true });

function statMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

for (const [who, path] of [
  ['管理者', adminState],
  ['一般利用者', userState],
] as const) {
  if (!existsSync(path)) {
    console.error(`storageState がありません（${who}）: ${path}\n先に otp-login.ts を実行し、OTP でログインしてください。`);
    process.exit(2);
  }
  if (statMode(path) !== 0o600) {
    console.error(`storageState の権限が 0600 ではありません（${who}）`);
    process.exit(2);
  }
}

const rawArgs = process.argv.slice(2);
const extra = (rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs).filter((a) => a !== '--');
const startedAt = new Date().toISOString();
const summary: Record<string, unknown> = {
  layer,
  project,
  baseUrl,
  startedAt,
  authDir,
  evidenceDir,
  passes: [] as { name: string; exit: number; evidence: string }[],
};

async function healthz(): Promise<unknown> {
  try {
    const res = await fetch(`${baseUrl}/healthz`, { redirect: 'manual' });
    const text = (await res.text()).slice(0, 300);
    return { status: res.status, contentType: res.headers.get('content-type'), body: text };
  } catch (error) {
    return { error: String(error) };
  }
}

function run(name: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  console.log(`\n=== ${name} ===`);
  return new Promise((resolve) => {
    const child = spawn('pnpm', args, { cwd: root, env, stdio: 'inherit' });
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

const common = ['-s', 'exec', 'playwright', 'test', '-c', 'playwright.approval.config.ts', `--project=${project}`];

const envBase: NodeJS.ProcessEnv = {
  ...process.env,
  E2E_LAYER: layer,
  E2E_BASE_URL: baseUrl,
  E2E_AUTH_DIR: authDir,
  E2E_ADMIN_STATE: adminState,
  E2E_USER_STATE: userState,
};

try {
  summary.healthz = await healthz();
  const pass1 = await run(`${layer} 本実行（A11 以外）`, [...common, '--grep-invert', '@logout-last', ...extra], {
    ...envBase,
    E2E_EVIDENCE_DIR: evidenceDir,
  });
  (summary.passes as { name: string; exit: number; evidence: string }[]).push({
    name: 'main',
    exit: pass1,
    evidence: evidenceDir,
  });

  let pass2: number | null = null;
  if (pass1 === 0) {
    pass2 = await run(`${layer} ログアウト確認（A11）`, [...common, '--grep', '@logout-last', ...extra], {
      ...envBase,
      E2E_EVIDENCE_DIR: logoutEvidenceDir,
    });
    (summary.passes as { name: string; exit: number; evidence: string }[]).push({
      name: 'logout',
      exit: pass2,
      evidence: logoutEvidenceDir,
    });
  } else {
    console.error('本実行が失敗したため、ログアウト（A11）は実行しません（storageState は残します）。');
  }

  summary.endedAt = new Date().toISOString();
  summary.ok = pass1 === 0 && pass2 === 0;
  if (summary.ok) {
    for (const path of [adminState, userState]) {
      rmSync(path, { force: true });
    }
    try {
      if (readdirSync(authDir).length === 0) rmSync(authDir, { recursive: true, force: true });
    } catch {
      // ディレクトリが残っていてもよい
    }
    summary.cleanup = 'storageState を削除した（ラウンド完了）';
  } else {
    summary.cleanup = 'storageState を残した（失敗のため。影響範囲の再実行に使える）';
  }
  writeFileSync(join(evidenceDir, `run-${layer}.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`\n${summary.ok ? '層の実行は成功' : '層の実行は失敗'}。証跡: ${evidenceDir}`);
  process.exit(summary.ok ? 0 : 1);
} catch (error) {
  summary.endedAt = new Date().toISOString();
  summary.error = String(error);
  writeFileSync(join(evidenceDir, `run-${layer}.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.error(error);
  process.exit(1);
}
