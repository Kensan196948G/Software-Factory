#!/usr/bin/env node
/**
 * Preview 環境の設定をワークスペース外に生成する。
 * 秘密情報はここで生成し、標準出力には出さない。
 *
 * 使い方: node scripts/setup-preview.mjs [--force]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = resolve(homedir(), '.config/mirai-sf');
const file = resolve(dir, 'preview.conf');
mkdirSync(dir, { recursive: true, mode: 0o700 });

const force = process.argv.includes('--force');
if (existsSync(file) && !force) {
  console.log(`Preview 設定は既にあります: ${file}（--force で再生成）`);
  process.exit(0);
}

let githubToken = process.env.GITHUB_TOKEN ?? '';
if (!githubToken) {
  try {
    githubToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    githubToken = '';
  }
}

const local = existsSync(resolve(dir, 'local.json')) ? JSON.parse(readFileSync(resolve(dir, 'local.json'), 'utf8')) : {};

// Issue #102: Access の JWT が未設定だと fail-closed になり、誰もログインできない。
// 生成物へ値を書くのは「環境変数で明示的に渡されたとき」だけにし、未設定なら警告する（黙って壊れた設定を作らない）。
const accessTeamDomain = (process.env.MIRAI_SF_ACCESS_TEAM_DOMAIN ?? '').trim();
const accessAud = (process.env.MIRAI_SF_ACCESS_AUD ?? '').trim();
const accessJwtComplete = Boolean(accessTeamDomain && accessAud);
const accessJwtPartial = Boolean(accessTeamDomain) !== Boolean(accessAud);

const lines = [
  '# みらいSF 受付ステーション Preview 環境（0600・commit しない）',
  'NODE_ENV=production',
  'APP_ENV=staging',
  'PORT=8782',
  'HOST=127.0.0.1',
  'APP_BASE_URL=https://sf.mirai-dx-platform.com',
  'DATABASE_URL=postgresql:///mirai_sf?host=/var/run/postgresql',
  'AUTH_MODE=access',
  'ACCESS_ALLOWED_DOMAIN=mirai-const.co.jp',
  'ACCESS_ALLOWED_EMAILS=',
  'ACCESS_SERVICE_TOKEN_IDS=',
  ...(accessJwtComplete
    ? [`ACCESS_TEAM_DOMAIN=${accessTeamDomain}`, `ACCESS_AUD=${accessAud}`]
    : ['# ACCESS_TEAM_DOMAIN=（未設定: Access の JWT を検証できないため、このままではログイン不可）', '# ACCESS_AUD=']),
  'SESSION_TTL_HOURS=12',
  'COOKIE_SECURE=1',
  'TRUST_PROXY=1',
  'REQUIRE_ORIGIN_SECRET=0',
  'ALLOW_SELF_APPROVAL=1',
  'ALLOW_IMPORT=1',
  `SEED_ADMIN_EMAIL=${local.SEED_ADMIN_EMAIL ?? 'admin@example.com'}`,
  'SEED_ADMIN_NAME=管理者',
  'SEED_ADMIN_DEPT=dx',
  'SEED_ADMIN_PASSWORD=',
  'APP_VERSION=0.1.0',
  'COMMIT_SHA=preview',
  'GITHUB_REPO=Kensan196948G/Software-Factory',
  `GITHUB_TOKEN=${githubToken}`,
  `SESSION_SECRET=${randomBytes(32).toString('base64url')}`,
  '',
];
writeFileSync(file, lines.join('\n'), { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Preview 設定を生成しました: ${file}`);
console.log(`GitHub 連携: ${githubToken ? '有効' : '無効（gh auth token が取得できません）'}`);
if (accessJwtComplete) {
  console.log('Access JWT 検証: 設定済み（ACCESS_TEAM_DOMAIN / ACCESS_AUD）');
} else {
  console.warn('警告: Access JWT の 2 項目が未設定です。Issue #102 の fail-closed により、この設定では誰もログインできません。');
  console.warn('      MIRAI_SF_ACCESS_TEAM_DOMAIN と MIRAI_SF_ACCESS_AUD を設定して --force で再生成してください。');
  if (accessJwtPartial) console.warn('      2 項目のうち片方だけが指定されています（両方必要）。');
}
