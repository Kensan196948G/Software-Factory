/**
 * fake CI。Runner の結果を見ずに、シナリオと job の回数だけから検証結果を作る。
 * 配信 ID を決定的にするので、worker が途中で落ちても同じ配信になり duplicate で無視される（契約 1章の 5）。
 */
import { createHash } from 'node:crypto';
import { REQUIRED_STAGES } from '../shared/devline.js';
import type { AcResult, FakeScenario, RecordVerificationInput, StageResult } from '../shared/devline.js';

export interface FakeCiJobFacts {
  jobId: string;
  headSha: string;
  repairCountTotal: number;
  ciRerunCount: number;
}

export const FAKE_FAILING_TEST = 'fake.unit.sample';

export function buildFakeVerification(
  job: FakeCiJobFacts,
  scenario: FakeScenario,
  acIds: readonly string[],
  ctx: { now: Date; correlationId: string },
): RecordVerificationInput {
  const fails = scenario === 'same_cause_fail' || (scenario === 'test_fail_then_fix' && job.repairCountTotal === 0);
  const stages: StageResult[] = REQUIRED_STAGES.map((stage) =>
    fails && stage === 'unit' ? { stage, status: 'failed', failedTestIds: [FAKE_FAILING_TEST] } : { stage, status: 'passed' },
  );
  const acResults: AcResult[] = acIds.map((acId) => ({
    acId,
    testIds: [`fake.${acId.toLowerCase()}`],
    status: 'passed',
  }));
  const reportDigest = createHash('sha256')
    .update(JSON.stringify({ headSha: job.headSha, stages, acResults }), 'utf8')
    .digest('hex');
  return {
    jobId: job.jobId,
    deliveryId: `fake:${job.jobId}:${job.headSha}:${job.ciRerunCount}`,
    source: 'fake_ci',
    ciRunId: `fake-run:${job.headSha}:${job.ciRerunCount}`,
    runSequence: job.repairCountTotal * 100 + job.ciRerunCount + 1,
    runAttempt: 1,
    headSha: job.headSha,
    stages,
    acResults,
    logRef: null,
    reportDigest,
    now: ctx.now,
    correlationId: ctx.correlationId,
  };
}
