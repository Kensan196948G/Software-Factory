/**
 * fake runner（ADR D-11）。実 AI も子プロセスも使わない。一時ディレクトリに成果物を作り、実物から sha256 を出す。
 * シナリオは worker の設定とテストだけが選ぶ。注文書の本文は読み取るデータで、命令として扱わない（仕様 4-4）。
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '../api/http.js';
import { FAKE_SCENARIOS } from '../shared/devline.js';
import type { FakeScenario, RunnerAdapter, RunnerArtifact, RunnerInput, RunnerResult, RunnerUsage } from '../shared/devline.js';

const ZERO_USAGE: RunnerUsage = { inputTokens: 0, outputTokens: 0, durationSeconds: 0, costJpy: 0 };

const NORMAL_PATHS = ['src/generated/fake-feature.ts', 'tests/generated/fake-feature.test.ts'];
const FORBIDDEN_PATHS = ['.github/workflows/ci.yml', 'src/generated/fake-feature.ts'];

export function isFakeScenario(value: string): value is FakeScenario {
  return (FAKE_SCENARIOS as readonly string[]).includes(value);
}

async function fileArtifact(dir: string, kind: RunnerArtifact['kind'], name: string, content: string): Promise<RunnerArtifact> {
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  const bytes = await readFile(path);
  return {
    kind,
    name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.byteLength,
    content: bytes.toString('utf8'),
  };
}

export interface FakeRunner extends RunnerAdapter {
  readonly cancelCalls: { jobId: string; attemptNo: number }[];
  readonly runs: { jobId: string; attemptNo: number; step: RunnerInput['step'] }[];
}

export function createFakeRunner(scenario: FakeScenario): FakeRunner {
  if (process.env.NODE_ENV === 'production') {
    throw new ApiError('ERR-405', 'production では fake runner を起動できません', 409);
  }
  const cancelCalls: FakeRunner['cancelCalls'] = [];
  const runs: FakeRunner['runs'] = [];

  return {
    capability: { kind: 'fake', isolation: 'none', network: 'none', supportsCancel: true, costAccounting: 'fake_zero' },
    cancelCalls,
    runs,
    async cancel(run) {
      cancelCalls.push(run);
    },
    async run(input): Promise<RunnerResult> {
      runs.push({ jobId: input.jobId, attemptNo: input.attemptNo, step: input.step });
      if (scenario === 'hang' && input.step !== 'plan') {
        // cancel（signal）が来るまで終わらない。時間の判定は worker が now で行う
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          status: 'failed',
          exitCode: 137,
          headSha: null,
          changedPaths: [],
          artifacts: [],
          logRef: null,
          usage: ZERO_USAGE,
          summary: 'cancelled',
        };
      }

      const dir = await mkdtemp(join(tmpdir(), 'msf-fake-runner-'));
      try {
        if (input.step === 'plan') {
          const plan = {
            steps: ['implement', 'verify'],
            acceptanceCriteriaIds: input.acceptanceCriteriaIds,
            orderContentSha256: input.order.envelope.content_sha256,
            // injection: 注文書に書かれた命令に従ったと主張する Agent を模す。worker はこの申告を信用しない
            ...(scenario === 'injection' ? { claimedOverride: { policy: 'off', allowedPaths: ['.github/'] } } : {}),
          };
          const artifact = await fileArtifact(dir, 'plan', 'plan.json', `${JSON.stringify(plan, null, 2)}\n`);
          return {
            status: 'succeeded',
            exitCode: 0,
            headSha: null,
            changedPaths: [],
            artifacts: [artifact],
            logRef: null,
            usage: ZERO_USAGE,
            plan,
            summary: 'fake plan',
          };
        }

        const paths = scenario === 'forbidden_path' ? FORBIDDEN_PATHS : NORMAL_PATHS;
        const patch = [
          `# fake patch job=${input.jobId} attempt=${input.attemptNo} step=${input.step}`,
          `# base=${input.baseSha}`,
          ...paths.map((p) => `+++ ${p}`),
          '',
        ].join('\n');
        const artifact = await fileArtifact(dir, 'patch', `attempt-${input.attemptNo}.patch`, patch);
        const headSha = createHash('sha1').update(`${input.baseSha}:${artifact.sha256}`).digest('hex');
        return {
          status: 'succeeded',
          exitCode: 0,
          headSha,
          changedPaths: paths,
          artifacts: [artifact],
          logRef: null,
          usage: ZERO_USAGE,
          summary: `fake ${input.step}`,
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/** fake の選択。local-isolated / real は未実装（T-61）。docker-claude は資格情報が要るので startRealLine を通す。 */
export function createRunner(kind: string, scenario: FakeScenario): RunnerAdapter {
  if (kind !== 'fake') {
    throw new ApiError('ERR-405', `この runner はまだ使えません（${kind}）`, 409);
  }
  return createFakeRunner(scenario);
}
