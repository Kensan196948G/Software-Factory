/** merge・配備・戻しの要求の形。repo・イメージ・ポートは受けない（strict で拒否する）。 */
import { z } from 'zod';

const sha = z.string().regex(/^[0-9a-f]{40}$/);

export const approveMergeSchema = z.strictObject({ headSha: sha });
export const approveDeploySchema = z.strictObject({
  sha,
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  environment: z.string().min(1).max(64),
});
export const rollbackSchema = z.strictObject({ reason: z.string().trim().min(1).max(500) });
export const revokeApprovalSchema = z.strictObject({ headSha: sha, reason: z.string().trim().min(1).max(500) });
