/**
 * 実 runner（DEVLINE_RUNNER_KIND=docker-claude）の設定と資格情報の読み取り。
 * API と worker の両方が使う。Docker や AI の実行には触らない。
 * 値はエラーに載せない。設定が足りないときは拒否し、fake へ落とさない。
 */
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AUTO_MERGE_POLICY_VERSION, DEVLINE_REPO_LEDGER, REAL_RUNNER_POLICY, diffPolicyForRepo, ledgerEntryFor } from '../shared/devline.js';
import type { AllowedRepo, RepoAllowEntry, RepoDiffPolicy, RunnerBudget } from '../shared/devline.js';

export const DEFAULT_SECRETS_PATH = join(homedir(), '.config', 'mirai-sf', 'devline-secrets.env');

export interface DevlineSecrets {
  anthropicApiKey: string;
  githubToken: string;
}

export class RealLineRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealLineRefused';
  }
}

/**
 * 資格情報のファイルから指定の名前だけを読む。symlink・通常ファイル以外・他人のファイル・0600 以外は拒否する。
 * 試験では既定の path を読ませない。
 */
function readSecretValues<K extends string>(path: string, nodeEnv: string, names: readonly K[]): Partial<Record<K, string>> {
  if (nodeEnv === 'test' && path === DEFAULT_SECRETS_PATH) {
    throw new RealLineRefused('試験では既定の資格情報ファイルを読みません');
  }
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new RealLineRefused('資格情報のファイルがありません');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new RealLineRefused('資格情報のファイルが通常のファイルではありません');
  if ((stat.mode & 0o777) !== 0o600) throw new RealLineRefused('資格情報のファイルの権限が 0600 ではありません');
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new RealLineRefused('資格情報のファイルの所有者が実行ユーザーではありません');

  const values: Partial<Record<K, string>> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && (names as readonly string[]).includes(m[1] as string)) {
      values[m[1] as K] = (m[2] as string).replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return values;
}

/** worker 用。AI のキーと GitHub のトークンの両方が要る。 */
export function loadDevlineSecrets(path: string, nodeEnv: string): DevlineSecrets {
  const values = readSecretValues(path, nodeEnv, ['ANTHROPIC_API_KEY', 'DEVLINE_GITHUB_TOKEN']);
  if (!values.ANTHROPIC_API_KEY || !values.DEVLINE_GITHUB_TOKEN) {
    throw new RealLineRefused('資格情報が足りません（ANTHROPIC_API_KEY / DEVLINE_GITHUB_TOKEN）');
  }
  return { anthropicApiKey: values.ANTHROPIC_API_KEY, githubToken: values.DEVLINE_GITHUB_TOKEN };
}

/** API 用。Issue を作るトークンだけを読み、AI のキーを API のプロセスへ入れない。GITHUB_TOKEN は使わない。 */
export function loadDevlineGithubToken(path: string, nodeEnv: string): string {
  const { DEVLINE_GITHUB_TOKEN: token } = readSecretValues(path, nodeEnv, ['DEVLINE_GITHUB_TOKEN']);
  if (!token) throw new RealLineRefused('資格情報が足りません（DEVLINE_GITHUB_TOKEN）');
  return token;
}

/** 予算の設定（純関数）。上限を超える設定と読めない値は拒否する。 */
export function parseRunnerBudget(env: Record<string, string | undefined>): RunnerBudget {
  const rawLimit = env.DEVLINE_BUDGET_JPY ?? String(REAL_RUNNER_POLICY.maxBudgetJpy);
  const rawRate = env.DEVLINE_JPY_PER_USD ?? String(REAL_RUNNER_POLICY.defaultJpyPerUsd);
  const limitJpy = Number(rawLimit);
  const jpyPerUsd = Number(rawRate);
  if (!Number.isInteger(limitJpy) || limitJpy < 1) throw new RealLineRefused('DEVLINE_BUDGET_JPY が正しくありません');
  if (limitJpy > REAL_RUNNER_POLICY.maxBudgetJpy) {
    throw new RealLineRefused(`DEVLINE_BUDGET_JPY は ${REAL_RUNNER_POLICY.maxBudgetJpy} 以下にしてください（延長しません）`);
  }
  if (!Number.isFinite(jpyPerUsd) || jpyPerUsd < 100) throw new RealLineRefused('DEVLINE_JPY_PER_USD が正しくありません');
  return { limitJpy, jpyPerUsd };
}

/**
 * 実 runner を向けてよいか（純関数）。DEVLINE_TARGET_REPOS と**許可台帳**の両方に名前と ID が載っていること。
 * 台帳は複数行を持つ。1件だけを強制しない（job ごとの repo は target_repo_id で持つ）。
 */
export function isRealRunnerTarget(
  repo: string,
  allowed: readonly AllowedRepo[],
  ledger: readonly RepoAllowEntry[] = DEVLINE_REPO_LEDGER,
  policyOf: (repo: string) => RepoDiffPolicy | null = diffPolicyForRepo,
): boolean {
  const configured = allowed.find((r) => r.name === repo);
  if (!configured) return false;
  const entry = ledgerEntryFor(repo, configured.repoId, ledger);
  return Boolean(entry && entry.private && policyOf(repo));
}

/** 設定だけで決まる起動の拒否（純関数）。接続はしない。 */
export function checkRealLineEnv(
  env: Record<string, string | undefined>,
  allowed: readonly AllowedRepo[],
  ledger: readonly RepoAllowEntry[] = DEVLINE_REPO_LEDGER,
  policyOf: (repo: string) => RepoDiffPolicy | null = diffPolicyForRepo,
): string | null {
  // Staging は NODE_ENV=production で動く。APP_ENV=staging を明示したときだけ許す。本番は常に拒否（所有者の決定、2026-11-01）
  if (env.NODE_ENV === 'production' && env.APP_ENV !== 'staging') return 'production では docker-claude を起動しません';
  if (!allowed.some((r) => isRealRunnerTarget(r.name, allowed, ledger, policyOf))) {
    return 'DEVLINE_TARGET_REPOS に実 runner の許可先がありません';
  }
  const stray = allowed.filter((r) => !isRealRunnerTarget(r.name, allowed, ledger, policyOf));
  if (stray.length > 0) return 'DEVLINE_TARGET_REPOS に実 runner の許可先以外が含まれています';
  try {
    parseRunnerBudget(env);
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

/** 自動マージの設定（DEVLINE_AUTO_MERGE）。既定は無効で、読めない値は拒否する（fail-closed）。 */
export interface AutoMergePolicy {
  enabled: boolean;
  /** 監査に残す設定値（'1' / '0' / 未設定は空）。 */
  configuredValue: string;
  /** 判定根拠に残すポリシー版。 */
  policyVersion: string;
}

/**
 * DEVLINE_AUTO_MERGE の解釈（純関数）。既定は 0（無効）。'0' / '1' 以外は拒否する。
 * production では既定 0 のままとし、明示的に 1 にしても APP_ENV=staging（検証環境）でなければ拒否する。
 * 実 runner 本体（docker-claude）と同じ境界で、本番の自動 merge は作らない。
 */
export function parseAutoMergePolicy(env: Record<string, string | undefined>): AutoMergePolicy {
  const raw = (env.DEVLINE_AUTO_MERGE ?? '').trim();
  const disabled: AutoMergePolicy = { enabled: false, configuredValue: raw, policyVersion: AUTO_MERGE_POLICY_VERSION };
  if (raw === '' || raw === '0') return disabled;
  if (raw !== '1') throw new RealLineRefused('DEVLINE_AUTO_MERGE は 0 か 1 で指定してください');
  if (env.NODE_ENV === 'production' && env.APP_ENV !== 'staging') {
    throw new RealLineRefused('本番（APP_ENV=production）では自動マージを有効にできません（APP_ENV=staging の検証環境だけ）');
  }
  return { enabled: true, configuredValue: '1', policyVersion: AUTO_MERGE_POLICY_VERSION };
}
