import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  host: string;
  appBaseUrl: string;
  databaseUrl: string;
  sessionSecret: string;
  originSharedSecret: string;
  requireOriginSecret: boolean;
  trustProxy: boolean;
  appVersion: string;
  commitSha: string;
  seedAdminEmail: string;
  seedAdminName: string;
  seedAdminDept: string;
  seedAdminPassword: string;
  cookieSecure: boolean;
  sessionTtlHours: number;
  /** 個人利用MVPの検証用。本番では false（ERR-105 自分で自分を承認しない）。 */
  allowSelfApproval: boolean;
  /** JSON 取込（全件置換）を許可するか。 */
  allowImport: boolean;
  /** password: アプリのログイン画面 / access: Cloudflare Access の認証結果を使う */
  authMode: 'password' | 'access';
  accessAllowedEmails: string[];
  accessAllowedDomain: string;
  accessServiceTokenIds: string[];
  /** Access の JWT 検証。両方そろうと JWT 必須。空ならヘッダを信頼する従来動作（access-jwt.ts）。 */
  accessTeamDomain: string;
  accessAud: string;
  /** GitHub Issue 自動作成（未設定なら無効） */
  githubToken: string;
  githubRepo: string;
  /** 承認依頼メールの送信経路。off=送らない / file=ローカルの送信BOX / sendmail=ローカルMTA */
  mailMode: 'off' | 'file' | 'sendmail' | 'smtp';
  mailFrom: string;
  /** 承認者のメールアドレスが引けないときの宛先（空なら送らない） */
  mailApprovalTo: string;
  mailOutboxDir: string;
  sendmailPath: string;
  /** SMTP（MAIL_MODE=smtp）の接続先。認証情報は設定ファイル（0600）か環境変数だけに置く。 */
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpRequireTls: boolean;
  smtpUser: string;
  smtpPass: string;
  /** 送信失敗の自動リトライ（回数・初回間隔）。日次/手動の flush が期日を過ぎたものを送る。 */
  mailRetryMax: number;
  mailRetryBaseMinutes: number;
  /** 下書きの保存期限（日）。日次ジョブが期限切れを消す。0以下は削除しない。 */
  draftTtlDays: number;
}

type RawConfig = Record<string, string | undefined>;

/** 任意の JSON 設定ファイル（ワークスペース外に置く）を読み込む。 */
function readConfigFile(path: string | undefined): RawConfig {
  if (!path) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RawConfig;
    return parsed ?? {};
  } catch (err) {
    throw new Error(`設定ファイルを読み込めません: ${path} (${(err as Error).message})`);
  }
}

function pick(file: RawConfig, key: string, envKey = key): string | undefined {
  return process.env[envKey] ?? file[key];
}

/** ACCESS_TEAM_DOMAIN を https のオリジンへ正規化する（JWT の iss と比較し、公開鍵の取得先にも使う）。 */
function normalizeTeamDomain(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('ACCESS_TEAM_DOMAIN が不正です（https://<team>.cloudflareaccess.com の形式）');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ACCESS_TEAM_DOMAIN が不正です（https://<team>.cloudflareaccess.com の形式）');
  }
  return url.origin;
}

/**
 * JWT 検証の設定。片方だけの設定は、検証しているつもりでヘッダを信頼する事故になるので起動エラーにする。
 * AUTH_MODE=password では使わない。
 */
function accessJwtSettingsOf(
  authMode: AppConfig['authMode'],
  rawDomain: string | undefined,
  rawAud: string | undefined,
): Pick<AppConfig, 'accessTeamDomain' | 'accessAud'> {
  const domain = rawDomain?.trim() ?? '';
  const aud = rawAud?.trim() ?? '';
  if (authMode !== 'access' || (!domain && !aud)) return { accessTeamDomain: '', accessAud: '' };
  if (!domain || !aud) throw new Error('ACCESS_TEAM_DOMAIN と ACCESS_AUD は両方設定してください');
  return { accessTeamDomain: normalizeTeamDomain(domain), accessAud: aud };
}

/** Access の JWT 検証が有効か（AUTH_MODE=access かつ両方設定済み）。 */
export function isAccessJwtEnabled(cfg: Pick<AppConfig, 'authMode' | 'accessTeamDomain' | 'accessAud'>): boolean {
  return cfg.authMode === 'access' && Boolean(cfg.accessTeamDomain && cfg.accessAud);
}

/** 本番モードで JWT 検証なしのまま Access のヘッダを信頼しているときの警告文。問題なければ null。 */
export function accessJwtStartupWarning(
  cfg: Pick<AppConfig, 'isProduction' | 'authMode' | 'accessTeamDomain' | 'accessAud'>,
): string | null {
  if (!cfg.isProduction || cfg.authMode !== 'access' || isAccessJwtEnabled(cfg)) return null;
  return 'AUTH_MODE=access ですが ACCESS_TEAM_DOMAIN / ACCESS_AUD が未設定です。Access の JWT を検証せず、ヘッダのメールを信頼します';
}

/** MAIL_MODE の解釈。本番の既定は off（通知連携は対象外のため勝手に送らない）。 */
function mailModeOf(raw: string | undefined, isProduction: boolean): 'off' | 'file' | 'sendmail' | 'smtp' {
  const value = (raw ?? (isProduction ? 'off' : 'file')).trim().toLowerCase();
  if (value === 'off' || value === 'file' || value === 'sendmail' || value === 'smtp') return value;
  throw new Error(`MAIL_MODE が不正です: ${value}（off / file / sendmail / smtp のいずれか）`);
}

export function loadConfig(overrides: RawConfig = {}): AppConfig {
  const file = { ...readConfigFile(process.env.MIRAI_SF_CONFIG_FILE), ...overrides };
  const nodeEnv = (pick(file, 'NODE_ENV') ?? 'development') as AppConfig['nodeEnv'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error(`NODE_ENV が不正です: ${nodeEnv}`);
  }
  const isProduction = nodeEnv === 'production';

  const databaseUrl = pick(file, 'DATABASE_URL');
  if (!databaseUrl) {
    throw new Error('DATABASE_URL が未設定です（PostgreSQL の接続文字列）');
  }

  const sessionSecret = pick(file, 'SESSION_SECRET') ?? randomBytes(32).toString('base64url');
  const originSharedSecret = pick(file, 'ORIGIN_SHARED_SECRET') ?? '';
  const authMode: AppConfig['authMode'] = (pick(file, 'AUTH_MODE') ?? 'password') === 'access' ? 'access' : 'password';

  return {
    nodeEnv,
    isProduction,
    port: Number(pick(file, 'PORT') ?? 8781),
    host: pick(file, 'HOST') ?? '127.0.0.1',
    appBaseUrl: pick(file, 'APP_BASE_URL') ?? 'http://127.0.0.1:8781',
    databaseUrl,
    sessionSecret,
    originSharedSecret,
    requireOriginSecret: (pick(file, 'REQUIRE_ORIGIN_SECRET') ?? (isProduction ? '1' : '0')) === '1',
    trustProxy: (pick(file, 'TRUST_PROXY') ?? '1') === '1',
    appVersion: pick(file, 'APP_VERSION') ?? '0.1.0',
    commitSha: pick(file, 'COMMIT_SHA') ?? 'dev',
    seedAdminEmail: pick(file, 'SEED_ADMIN_EMAIL') ?? 'admin@example.com',
    seedAdminName: pick(file, 'SEED_ADMIN_NAME') ?? '管理者',
    seedAdminDept: pick(file, 'SEED_ADMIN_DEPT') ?? 'dx',
    seedAdminPassword: pick(file, 'SEED_ADMIN_PASSWORD') ?? '',
    cookieSecure: (pick(file, 'COOKIE_SECURE') ?? (isProduction ? '1' : '0')) === '1',
    sessionTtlHours: Number(pick(file, 'SESSION_TTL_HOURS') ?? 12),
    allowSelfApproval: (pick(file, 'ALLOW_SELF_APPROVAL') ?? '1') === '1',
    allowImport: (pick(file, 'ALLOW_IMPORT') ?? '1') === '1',
    authMode,
    accessAllowedEmails: (pick(file, 'ACCESS_ALLOWED_EMAILS') ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    accessAllowedDomain: (pick(file, 'ACCESS_ALLOWED_DOMAIN') ?? '').trim().toLowerCase(),
    accessServiceTokenIds: (pick(file, 'ACCESS_SERVICE_TOKEN_IDS') ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
    ...accessJwtSettingsOf(authMode, pick(file, 'ACCESS_TEAM_DOMAIN'), pick(file, 'ACCESS_AUD')),
    githubToken: pick(file, 'GITHUB_TOKEN') ?? '',
    githubRepo: pick(file, 'GITHUB_REPO') ?? 'Kensan196948G/Software-Factory',
    mailMode: mailModeOf(pick(file, 'MAIL_MODE'), isProduction),
    mailFrom: pick(file, 'MAIL_FROM') ?? 'no-reply@mirai-sf.local',
    mailApprovalTo: (pick(file, 'MAIL_APPROVAL_TO') ?? '').trim(),
    mailOutboxDir: pick(file, 'MAIL_OUTBOX_DIR') ?? '.mail/outbox',
    sendmailPath: pick(file, 'SENDMAIL_PATH') ?? '/usr/sbin/sendmail',
    smtpHost: pick(file, 'SMTP_HOST') ?? '',
    smtpPort: Number(pick(file, 'SMTP_PORT') ?? 587),
    smtpSecure: (pick(file, 'SMTP_SECURE') ?? '0') === '1',
    smtpRequireTls: (pick(file, 'SMTP_REQUIRE_TLS') ?? '1') === '1',
    smtpUser: pick(file, 'SMTP_USER') ?? '',
    smtpPass: pick(file, 'SMTP_PASS') ?? '',
    mailRetryMax: Number(pick(file, 'MAIL_RETRY_MAX') ?? 3),
    mailRetryBaseMinutes: Number(pick(file, 'MAIL_RETRY_BASE_MINUTES') ?? 5),
    draftTtlDays: Number(pick(file, 'DRAFT_TTL_DAYS') ?? 30),
  };
}

export const config = loadConfig();
