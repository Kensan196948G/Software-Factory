import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseDevlineTargetRepos, type AllowedRepo } from '../shared/devline.js';

export interface AppConfig {
  /** 実行モード。isProduction など、セキュリティ挙動の既定値はこちらで決める。 */
  nodeEnv: 'development' | 'test' | 'production';
  /**
   * 環境名。主に表示用だが、ACCESS_TRUST_EMAIL_HEADER の許可判定（Issue #102）だけは appEnv も見る。
   * Cookie の Secure など他のセキュリティ既定値は nodeEnv / isProduction で決める。
   */
  appEnv: 'development' | 'test' | 'staging' | 'production';
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
  /**
   * 自己承認を許可するか（ERR-105 自分で自分を承認しない）。
   * 開発・テストの既定は true（従来動作）。APP_ENV=production の既定は false。
   */
  allowSelfApproval: boolean;
  /**
   * APP_ENV=production なのに ALLOW_SELF_APPROVAL=1 を明示したか。
   * true のときは自己承認を許可したまま、起動時と自己承認のたびに監査へ警告を残す。
   */
  selfApprovalForcedInProduction: boolean;
  /** JSON 取込（全件置換）を許可するか。 */
  allowImport: boolean;
  /** password: アプリのログイン画面 / access: Cloudflare Access の JWT を検証（ヘッダ信頼は明示 opt-in のみ） */
  authMode: 'password' | 'access';
  accessAllowedEmails: string[];
  accessAllowedDomain: string;
  accessServiceTokenIds: string[];
  /** Access の JWT 検証。両方そろうと JWT 必須。空ならヘッダを信頼しない（fail-closed。Issue #102）。 */
  accessTeamDomain: string;
  accessAud: string;
  /**
   * JWT 未設定のときに Cloudflare Access のヘッダ（email / client-id）を信頼する明示 opt-in。
   * 既定は false（fail-closed）。APP_ENV=staging / production では 1 を起動エラーにする（Issue #102）。
   */
  accessTrustEmailHeader: boolean;
  /**
   * 未登録の Access 利用者を初回ログイン時に自動作成する明示 opt-in（ACCESS_AUTO_PROVISION）。
   * 既定は false。有効時も最小権限（is_admin=false・requester のみ）で作り、`user.provisioned` を監査に残す。
   * 本番・staging（NODE_ENV=production を含む）では 1 を起動エラーにする（Issue #102 の完了条件 3）。
   */
  accessAutoProvision: boolean;
  /** GitHub Issue 自動作成（未設定なら無効） */
  githubToken: string;
  githubRepo: string;
  /** GitHub API の接続先。試験ではローカルの fake サーバだけを指す。 */
  githubApiUrl: string;
  /**
   * 開発ラインの投入を許可するリポジトリ（DEVLINE_TARGET_REPOS）。既定は空で、投入はすべて拒否する。
   * GITHUB_REPO を暗黙の許可先にしない（注文書 YAML に依頼者欄・承認者欄が載るため）。
   */
  devlineTargetRepos: readonly AllowedRepo[];
  /** 投入で作る job の runner（DEVLINE_RUNNER_KIND）。サーバの設定だけで決め、画面から指定させない。 */
  devlineRunnerKind: string;
  /** 実 runner の資格情報のファイル（DEVLINE_SECRETS_FILE）。空なら既定の path。 */
  devlineSecretsFile: string;
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

/**
 * Cloudflare Access のログアウト URL。アプリのセッションだけ消しても Access の Cookie が残ると
 * 次のリクエストで同じ利用者として自動ログインしてしまうため、画面のログアウトは両方を終える。
 * AUTH_MODE=password では null（アプリのログイン画面へ戻す）。
 */
export function accessLogoutUrl(cfg: Pick<AppConfig, 'authMode' | 'accessTeamDomain'>): string | null {
  if (cfg.authMode !== 'access' || !cfg.accessTeamDomain) return null;
  return `${cfg.accessTeamDomain.replace(/\/+$/, '')}/cdn-cgi/access/logout`;
}

/**
 * JWT 未設定のときに Access のヘッダを信頼してよいか（Issue #102 の恒久修正）。
 * 明示 opt-in（ACCESS_TRUST_EMAIL_HEADER=1）があり、かつ本番・staging でないときだけ true。
 * 既定は false の fail-closed。起動時にも本番・staging の opt-in は拒否するが、ここでも二重に判定する。
 */
export function isAccessHeaderTrustEnabled(
  cfg: Pick<AppConfig, 'authMode' | 'accessTrustEmailHeader' | 'appEnv' | 'isProduction'>,
): boolean {
  if (cfg.authMode !== 'access' || !cfg.accessTrustEmailHeader) return false;
  if (cfg.isProduction || cfg.appEnv === 'staging' || cfg.appEnv === 'production') return false;
  return true;
}

/**
 * 未登録利用者の自動作成（ACCESS_AUTO_PROVISION）が実際に有効か（Issue #102 の完了条件 3）。
 * 明示 opt-in があり、かつ本番・staging でないときだけ true。既定は false の fail-closed。
 * 起動時にも本番・staging の opt-in は拒否するが、ここでも二重に判定する。
 */
export function isAccessAutoProvisionEnabled(cfg: Pick<AppConfig, 'accessAutoProvision' | 'appEnv' | 'isProduction'>): boolean {
  if (!cfg.accessAutoProvision) return false;
  if (cfg.isProduction || cfg.appEnv === 'staging' || cfg.appEnv === 'production') return false;
  return true;
}

/** 外形監視に出す認証の状態。値（team domain・AUD・メール）は含めない。 */
export interface AuthHealthStatus {
  mode: AppConfig['authMode'];
  /** JWT 検証が設定済みか（access モードかつ ACCESS_TEAM_DOMAIN / ACCESS_AUD がそろっている）。 */
  jwtConfigured: boolean;
  /** JWT 未設定時のヘッダ信頼 opt-in が実際に有効か。 */
  headerTrustEnabled: boolean;
  /** 許可するメール／ドメインが設定されているか（空なら JWT が通っても全員拒否になる）。 */
  allowlistConfigured: boolean;
  /**
   * 有効な利用者の件数。`/healthz` が DB から取得できたときだけ数値。
   * - 数値: 取得できた件数（0 は認証全断）
   * - `null`: DB は正常だが件数を取得できなかった（権限・スキーマ・一時障害。監視は fail-closed）
   * - 省略: 旧 API（版ずれ。監視は警告に留める）
   */
  usersActive?: number | null;
  /** ready: 認証経路がある / misconfigured: 認証できる経路が無い（401 が続く状態）。 */
  status: 'ready' | 'misconfigured';
}

/**
 * 稼働中の API が「認証不能」かを外形監視から判別するための状態（Issue #102 の残リスク）。
 * access モードで、JWT もヘッダ信頼も許可リストも無い場合は、どの経路でも 401 になるため misconfigured。
 * password モードはアプリのログインで認証できるので常に ready（Access の設定は使わない）。
 * 返すのは mode・真偽値・status だけで、team domain / AUD / メールアドレスは返さない。
 */
export function authHealthStatus(
  cfg: Pick<
    AppConfig,
    | 'authMode'
    | 'accessTeamDomain'
    | 'accessAud'
    | 'accessTrustEmailHeader'
    | 'accessAllowedEmails'
    | 'accessAllowedDomain'
    | 'appEnv'
    | 'isProduction'
  >,
): AuthHealthStatus {
  const jwtConfigured = isAccessJwtEnabled(cfg);
  const headerTrustEnabled = isAccessHeaderTrustEnabled(cfg);
  const allowlistConfigured = cfg.accessAllowedEmails.length > 0 || Boolean(cfg.accessAllowedDomain);
  if (cfg.authMode === 'password') {
    return { mode: 'password', jwtConfigured, headerTrustEnabled, allowlistConfigured, status: 'ready' };
  }
  const status = (jwtConfigured || headerTrustEnabled) && allowlistConfigured ? 'ready' : 'misconfigured';
  return { mode: 'access', jwtConfigured, headerTrustEnabled, allowlistConfigured, status };
}

/** 本番モードで JWT 検証なしのまま Access のヘッダを信頼しているときの警告文。問題なければ null。 */
export function accessJwtStartupWarning(
  cfg: Pick<AppConfig, 'isProduction' | 'authMode' | 'accessTeamDomain' | 'accessAud'>,
): string | null {
  if (!cfg.isProduction || cfg.authMode !== 'access' || isAccessJwtEnabled(cfg)) return null;
  return 'AUTH_MODE=access ですが ACCESS_TEAM_DOMAIN / ACCESS_AUD が未設定です。Access の JWT を検証せず、Access のヘッダも信頼しません（ACCESS_TRUST_EMAIL_HEADER の opt-in は本番・staging で拒否します）。この状態では認証できません';
}

/** MAIL_MODE の解釈。本番の既定は off（通知連携は対象外のため勝手に送らない）。 */
function mailModeOf(raw: string | undefined, isProduction: boolean): 'off' | 'file' | 'sendmail' | 'smtp' {
  const value = (raw ?? (isProduction ? 'off' : 'file')).trim().toLowerCase();
  if (value === 'off' || value === 'file' || value === 'sendmail' || value === 'smtp') return value;
  throw new Error(`MAIL_MODE が不正です: ${value}（off / file / sendmail / smtp のいずれか）`);
}

/** APP_ENV の解釈。未指定・空なら NODE_ENV と同じ名前にする。 */
function appEnvOf(raw: string | undefined, nodeEnv: AppConfig['nodeEnv']): AppConfig['appEnv'] {
  const value = raw?.trim() || nodeEnv;
  if (value === 'development' || value === 'test' || value === 'staging' || value === 'production') return value;
  throw new Error(`APP_ENV が不正です: ${value}（development / test / staging / production のいずれか）`);
}

/**
 * ACCESS_TRUST_EMAIL_HEADER の解釈（Issue #102）。既定は無効。
 * 1 は「APP_ENV を明示した開発・テスト環境」だけ許可する。本番・staging、APP_ENV 未設定では
 * 起動エラーにする（fail-closed）。
 * password モードは JWT 設定と同じく対象外で、値があっても無言で無効にする（起動エラーにはしない）。
 * 1 を許可できない構成のうち、設定ミスとみなせるものだけを起動エラーにする。
 */
function accessTrustEmailHeaderOf(
  raw: string | undefined,
  authMode: AppConfig['authMode'],
  appEnv: AppConfig['appEnv'],
  appEnvExplicit: boolean,
  isProduction: boolean,
): boolean {
  const value = raw?.trim();
  if (value === undefined || value === '') return false;
  if (authMode !== 'access') return false;
  if (value !== '0' && value !== '1') throw new Error('ACCESS_TRUST_EMAIL_HEADER が不正です（0 / 1 のいずれか）');
  if (value === '0') return false;
  if (isProduction || appEnv === 'staging' || appEnv === 'production') {
    throw new Error(
      'ACCESS_TRUST_EMAIL_HEADER=1 は本番・staging では使えません。Access の JWT 検証（ACCESS_TEAM_DOMAIN / ACCESS_AUD）を設定してください',
    );
  }
  if (!appEnvExplicit) {
    throw new Error(
      'ACCESS_TRUST_EMAIL_HEADER=1 は APP_ENV を明示した development / test でのみ使えます（APP_ENV 未設定は development とみなしますが opt-in は許可しません）',
    );
  }
  return true;
}

/**
 * ACCESS_AUTO_PROVISION の解釈（Issue #102 の完了条件 3）。既定は無効。
 * 0 / 1 以外は起動エラー。1 は本番・staging（NODE_ENV=production を含む）では起動エラーにする（fail-closed）。
 * この値を使うのは Access ログインの経路だけなので、AUTH_MODE=password でも値の検証は行う。
 */
function accessAutoProvisionOf(raw: string | undefined, appEnv: AppConfig['appEnv'], isProduction: boolean): boolean {
  const value = raw?.trim();
  if (value === undefined || value === '') return false;
  if (value !== '0' && value !== '1') throw new Error('ACCESS_AUTO_PROVISION が不正です（0 / 1 のいずれか）');
  if (value === '0') return false;
  if (isProduction || appEnv === 'staging' || appEnv === 'production') {
    throw new Error(
      'ACCESS_AUTO_PROVISION=1 は本番・staging では使えません。利用者は管理API（/api/admin/users）で作成してください',
    );
  }
  return true;
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
  const rawAppEnv = pick(file, 'APP_ENV');
  const appEnv = appEnvOf(rawAppEnv, nodeEnv);
  const appEnvExplicit = Boolean(rawAppEnv?.trim());
  const authMode: AppConfig['authMode'] = (pick(file, 'AUTH_MODE') ?? 'password') === 'access' ? 'access' : 'password';
  const accessTrustEmailHeader = accessTrustEmailHeaderOf(
    pick(file, 'ACCESS_TRUST_EMAIL_HEADER'),
    authMode,
    appEnv,
    appEnvExplicit,
    isProduction,
  );
  const accessAutoProvision = accessAutoProvisionOf(pick(file, 'ACCESS_AUTO_PROVISION'), appEnv, isProduction);

  // 自己承認の既定は環境で決める。本番だけ既定で禁止し、明示の 1 は警告つきで許可する。
  const rawSelfApproval = pick(file, 'ALLOW_SELF_APPROVAL')?.trim();
  const explicitSelfApproval = rawSelfApproval === undefined || rawSelfApproval === '' ? undefined : rawSelfApproval;
  const allowSelfApprovalDefault = appEnv !== 'production';
  const allowSelfApproval = explicitSelfApproval === undefined ? allowSelfApprovalDefault : explicitSelfApproval === '1';
  const selfApprovalForcedInProduction = appEnv === 'production' && explicitSelfApproval === '1';

  return {
    nodeEnv,
    appEnv,
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
    allowSelfApproval,
    selfApprovalForcedInProduction,
    allowImport: (pick(file, 'ALLOW_IMPORT') ?? '1') === '1',
    authMode,
    ...accessJwtSettingsOf(authMode, pick(file, 'ACCESS_TEAM_DOMAIN'), pick(file, 'ACCESS_AUD')),
    accessTrustEmailHeader,
    accessAutoProvision,
    accessAllowedEmails: (pick(file, 'ACCESS_ALLOWED_EMAILS') ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    accessAllowedDomain: (pick(file, 'ACCESS_ALLOWED_DOMAIN') ?? '').trim().toLowerCase(),
    accessServiceTokenIds: (pick(file, 'ACCESS_SERVICE_TOKEN_IDS') ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
    githubToken: pick(file, 'GITHUB_TOKEN') ?? '',
    githubRepo: pick(file, 'GITHUB_REPO') ?? 'Kensan196948G/Software-Factory',
    githubApiUrl: pick(file, 'GITHUB_API_URL') ?? 'https://api.github.com',
    devlineTargetRepos: parseDevlineTargetRepos(pick(file, 'DEVLINE_TARGET_REPOS')),
    devlineRunnerKind: pick(file, 'DEVLINE_RUNNER_KIND') ?? 'fake',
    devlineSecretsFile: pick(file, 'DEVLINE_SECRETS_FILE') ?? '',
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
