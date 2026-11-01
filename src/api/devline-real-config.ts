/**
 * 実 runner（DEVLINE_RUNNER_KIND=docker-claude）の設定と資格情報の読み取り。
 * API と worker の両方が使う。Docker や AI の実行には触らない。
 * 値はエラーに載せない。設定が足りないときは拒否し、fake へ落とさない。
 */
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { REAL_RUNNER_POLICY, diffPolicyForRepo } from '../shared/devline.js';
import type { AllowedRepo, RunnerBudget } from '../shared/devline.js';

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

/** 実 runner を向けてよいか（純関数）。DEVLINE_TARGET_REPOS と定数の両方に名前と ID が載っていること。 */
export function isRealRunnerTarget(repo: string, allowed: readonly AllowedRepo[]): boolean {
  const configured = allowed.find((r) => r.name === repo);
  const fixed = REAL_RUNNER_POLICY.allowedRepos.find((r) => r.name === repo);
  return Boolean(configured && fixed && configured.repoId === fixed.repoId && diffPolicyForRepo(repo));
}

/** 設定だけで決まる起動の拒否（純関数）。接続はしない。 */
export function checkRealLineEnv(env: Record<string, string | undefined>, allowed: readonly AllowedRepo[]): string | null {
  // Staging は NODE_ENV=production で動く。所有者の決定で、APP_ENV=staging を明示したときだけ許す。本番は常に拒否
  if (env.NODE_ENV === 'production' && env.APP_ENV !== 'staging') return 'production では docker-claude を起動しません';
  if (!allowed.some((r) => isRealRunnerTarget(r.name, allowed))) {
    return 'DEVLINE_TARGET_REPOS に実 runner の許可先がありません';
  }
  const stray = allowed.filter((r) => !isRealRunnerTarget(r.name, allowed));
  if (stray.length > 0) return 'DEVLINE_TARGET_REPOS に実 runner の許可先以外が含まれています';
  try {
    parseRunnerBudget(env);
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}
