/**
 * Runner の結果の実行時検証。型は申告にすぎず、実 runner の出力は信用できない入力として扱う。
 * kind は Runner が作ってよい種類に限る（pr_body_draft は作れない）。zod 3 / 4 の両方で動く書き方に限る。
 */
import { z } from 'zod';
import type { RunnerResult } from '../shared/devline.js';

const MAX_ARTIFACT_BYTES = 262_144;

const artifactSchema = z.object({
  kind: z.enum(['plan', 'patch', 'log', 'test_report', 'runner_output']),
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: z.number().int().min(0),
  storageRef: z.string().max(500).nullable().optional(),
  content: z.string().nullable().optional(),
});

const resultSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'needs_human']),
  exitCode: z.number().int(),
  headSha: z.string().nullable(),
  changedPaths: z.array(z.string().max(1000)).max(5000),
  artifacts: z.array(artifactSchema).max(100),
  logRef: z.string().max(500).nullable(),
  usage: z.object({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    durationSeconds: z.number().min(0),
    costJpy: z.number().int().min(0),
  }),
  plan: z.unknown().optional(),
  humanApprovalTouched: z.array(z.string().max(500)).max(500).optional(),
  summary: z.string(),
  serverDiff: z
    .object({
      policyVersion: z.string().max(200),
      violations: z
        .array(
          z.object({
            path: z.string().max(1000),
            rule: z.string().max(50),
            detector: z.string().max(50).optional(),
            line: z.number().int().min(1).optional(),
          }),
        )
        .max(5000),
      humanApproval: z.array(z.string().max(1000)).max(5000),
    })
    .optional(),
  notStarted: z.boolean().optional(),
  budgetExceeded: z.boolean().optional(),
  costEstimated: z.boolean().optional(),
});

/** 読めない結果は null。成果物は本文の大きさと保存先も確かめる（DB の CHECK に落ちる前に runner の失敗にする）。 */
export function parseRunnerResult(raw: unknown): RunnerResult | null {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return null;
  for (const artifact of parsed.data.artifacts) {
    const hasContent = artifact.content !== null && artifact.content !== undefined;
    const ref = artifact.storageRef ?? null;
    if (!hasContent && ref === null) return null;
    if (hasContent && Buffer.byteLength(artifact.content as string, 'utf8') > MAX_ARTIFACT_BYTES) return null;
    if (ref !== null && (/^(\/|[A-Za-z]:)/.test(ref) || ref.includes('..'))) return null;
  }
  return parsed.data as RunnerResult;
}
