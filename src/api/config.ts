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
  };
}

export const config = loadConfig();
