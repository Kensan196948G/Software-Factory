/**
 * 開発ライン worker（`pnpm worker`）。Fastify の HTTP 要求の中では実行しない。
 * DEVLINE_WORKER_ENABLED=1 のときだけ動く。production では fake を起動しない。
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { closePool } from '../api/db.js';
import { config } from '../api/config.js';
import { autoMergeAfterPrReady, defaultAutoMergeDeps } from '../api/devline-auto-merge.js';
import { parseDevlineTargetRepos } from '../shared/devline.js';
import type { FakeScenario } from '../shared/devline.js';
import { createRunner, isFakeScenario } from './fake-runner.js';
import { runOnce } from './loop.js';
import { DEFAULT_SECRETS_PATH, checkRealLineEnv, loadDevlineSecrets, startRealLine, type RealLine } from './real-line.js';
import { createDeployDocker, createDeployProbe } from './deploy-docker.js';
import { createImageArtifactSource } from './deploy-artifact.js';
import { runDeployOnce, type DeployOutcome, type DeployWorkerOptions } from './deploy-worker.js';

const POLL_MS = 5_000;

export interface WorkerEnvDecision {
  start: boolean;
  /** 起動しない理由。start が true なら null。 */
  reason: string | null;
  runnerKind: string;
  scenario: FakeScenario;
}

/** 環境から起動の可否を決める（純関数・T-69）。 */
export function decideWorkerStart(env: Record<string, string | undefined>): WorkerEnvDecision {
  const runnerKind = env.DEVLINE_RUNNER_KIND ?? 'fake';
  const rawScenario = env.DEVLINE_FAKE_SCENARIO ?? 'success';
  const scenario: FakeScenario = isFakeScenario(rawScenario) ? rawScenario : 'success';
  const no = (reason: string): WorkerEnvDecision => ({ start: false, reason, runnerKind, scenario });
  if (env.DEVLINE_WORKER_ENABLED !== '1') return no('DEVLINE_WORKER_ENABLED=1 ではないので起動しません');
  if (env.NODE_ENV === 'production' && runnerKind === 'fake') return no('production では fake runner を起動しません');
  if (!isFakeScenario(rawScenario)) return no('DEVLINE_FAKE_SCENARIO の値が正しくありません');
  if (runnerKind === 'docker-claude') {
    // 資格情報とリポジトリの確認は startRealLine。ここは設定だけで決まる拒否（fake へ落とさない）
    try {
      const refused = checkRealLineEnv(env, parseDevlineTargetRepos(env.DEVLINE_TARGET_REPOS));
      if (refused) return no(refused);
    } catch (err) {
      return no((err as Error).message);
    }
  }
  return { start: true, reason: null, runnerKind, scenario };
}

/**
 * 1 回分の工程。runOnce の例外で配備を飢えさせない（別々に受ける）。進まなかったら true を返す（呼び出し側が待つ）。
 * lease は期限で切れるので、次の取得で取り直される。
 */
export async function workerTick(steps: {
  runOnce: () => Promise<Awaited<ReturnType<typeof runOnce>>>;
  deploy?: () => Promise<DeployOutcome>;
  shutdown?: AbortSignal;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}): Promise<boolean> {
  const log = steps.log ?? ((line) => console.log(line));
  const logError = steps.logError ?? ((line) => console.error(line));
  let idle = true;
  try {
    const outcome = await steps.runOnce();
    // 進まなかった工程（CI の結果待ちなど）も待つ。空回りで DB を叩き続けない
    idle = outcome.kind === 'idle' || (outcome.kind === 'stepped' && outcome.to === 'unchanged');
    if (outcome.kind !== 'idle') log(`[worker] ${JSON.stringify(outcome)}`);
  } catch (err) {
    logError(`[worker] step failed: ${(err as Error).name}`);
  }
  if (steps.deploy && !steps.shutdown?.aborted) {
    try {
      const deployed = await steps.deploy();
      if (deployed.kind !== 'idle') {
        idle = false;
        log(`[worker] ${JSON.stringify(deployed)}`);
      }
    } catch (err) {
      logError(`[worker] deploy step failed: ${(err as Error).name}`);
    }
  }
  return idle;
}

async function main(): Promise<void> {
  const decision = decideWorkerStart({ ...process.env, NODE_ENV: config.nodeEnv, APP_ENV: config.appEnv });
  if (!decision.start) {
    console.error(`[worker] ${decision.reason}`);
    process.exitCode = 1;
    return;
  }
  let line: RealLine | undefined;
  if (decision.runnerKind === 'docker-claude') {
    try {
      line = await startRealLine({
        env: process.env,
        allowedRepos: config.devlineTargetRepos,
        nodeEnv: config.nodeEnv,
        apiUrl: config.githubApiUrl,
      });
    } catch (err) {
      console.error(`[worker] 起動を拒否しました: ${(err as Error).message}`);
      process.exitCode = 1;
      await closePool();
      return;
    }
  }
  const runner = line ? line.runner : createRunner(decision.runnerKind, decision.scenario);
  const owner = `worker-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  // 検証環境への配備は別のスイッチ。merge の口はここに渡らない
  let deploy: DeployWorkerOptions | undefined;
  if (process.env.DEVLINE_DEPLOY_ENABLED === '1') {
    try {
      const token = line
        ? loadDevlineSecrets(process.env.DEVLINE_SECRETS_FILE ?? DEFAULT_SECRETS_PATH, config.nodeEnv).githubToken
        : (process.env.DEVLINE_GITHUB_TOKEN ?? '');
      deploy = {
        owner,
        docker: createDeployDocker(),
        probe: createDeployProbe(),
        artifacts: createImageArtifactSource({
          apiUrl: config.githubApiUrl,
          token,
          nodeEnv: config.nodeEnv,
          ...(process.env.DEVLINE_ARTIFACT_DIR ? { workDir: process.env.DEVLINE_ARTIFACT_DIR } : {}),
        }),
        clock: () => new Date(),
      };
    } catch (err) {
      console.error(`[worker] 配備の設定を拒否しました: ${(err as Error).message}`);
      process.exitCode = 1;
      await line?.close();
      await closePool();
      return;
    }
  }
  // 自動マージは明示設定（DEVLINE_AUTO_MERGE=1）のときだけ。無効（既定）なら契機を渡さない。
  // 設定の誤りは起動の拒否にする（fake の成功へ落とさない）。資格情報が読めないときも同じ。
  let autoMerge: ((jobId: string) => Promise<unknown>) | undefined;
  try {
    const autoMergeDeps = defaultAutoMergeDeps();
    if (autoMergeDeps) {
      autoMerge = (jobId) =>
        autoMergeAfterPrReady({ jobId, correlationId: `auto-merge-${randomUUID()}` }, autoMergeDeps);
    }
  } catch (err) {
    console.error(`[worker] 自動マージの設定を拒否しました: ${(err as Error).message}`);
    process.exitCode = 1;
    await line?.close();
    await closePool();
    return;
  }
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  console.log(`[worker] started runner=${decision.runnerKind} isolation=${runner.capability.isolation}`);

  while (!stop.signal.aborted) {
    if (line?.isLockHeld?.() === false) {
      // 別の worker が動き出せる状態。新しい AI を動かさず、終わる（監視の側で起動し直す）
      console.error('[worker] 排他を失ったので止まります');
      process.exitCode = 1;
      break;
    }
    const idle = await workerTick({
      runOnce: () =>
        runOnce({
          owner,
          runner,
          scenario: decision.scenario,
          clock: () => new Date(),
          shutdown: stop.signal,
          ...(line ? { line } : {}),
          ...(autoMerge ? { autoMerge } : {}),
        }),
      ...(deploy ? { deploy: () => runDeployOnce({ ...(deploy as DeployWorkerOptions), shutdown: stop.signal }) } : {}),
      shutdown: stop.signal,
    });
    if (idle) await delay(POLL_MS, undefined, { signal: stop.signal }).catch(() => undefined);
  }
  await line?.close();
  await closePool();
  console.log('[worker] stopped');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: Error) => {
    console.error(`[worker] fatal: ${err.name}`);
    process.exit(1);
  });
}
