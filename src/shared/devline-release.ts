/**
 * merge・配備・戻しの判定（純関数）と画面向けの型。仕様 4-9、FR-39〜41、BR-07、BR-08、TC-N09。
 * 判定はここだけに置く。API と worker は同じ関数を通す。
 * 「検証環境への配備」は本番公開ではない。released / closed へ進める判定をここに作らない。
 */
import type { JobState, VerificationVerdict } from './devline.js';

/** 配備先の環境名。ブラウザから受けない（承認の値と照合するだけ）。 */
export const DEPLOY_ENVIRONMENT = 'local-verify';
export const DEPLOY_CONTAINER_NAME = 'msf-sandbox-verify';
export const DEPLOY_LABEL = 'msf.devline.deploy=1';
/** 配備と一時確認のコンテナを置く内部ネットワーク（--internal。外部へ出られない。host からコンテナの IP で届く）。 */
export const DEPLOY_NETWORK_NAME = 'msf-devline-verify-net';
export const DEPLOY_CONTAINER_PORT = 8080;
/** CI の docker save が tar に入れるタグ（Sandbox の ci.yml）。これ以外のタグを持つ tar は読み込まない。 */
export const DEPLOY_ARTIFACT_TAG = 'sandbox-artifact:ci';
/** 検査した成果物の artifact の名前と meta の版（`msf.image/v1`）。 */
export const IMAGE_ARTIFACT_NAME = 'image';
export const IMAGE_META_SCHEMA = 'msf.image/v1';

export type MergeState = 'none' | 'sending' | 'unknown' | 'rejected' | 'merged';

/** 承認者の事実。role と isAgent はサーバがセッションと DB から決める。 */
export interface ApproverFacts {
  role: string;
  isAgent: boolean;
}

export type ReleaseRefusal =
  | 'role'
  | 'agent_actor'
  | 'state'
  | 'head_changed'
  | 'superseded'
  | 'order_not_current'
  | 'verification'
  | 'no_pr'
  | 'in_progress'
  | 'expired'
  | 'sha_mismatch'
  | 'digest_mismatch'
  | 'environment_mismatch'
  | 'tree_mismatch'
  | 'no_artifact'
  | 'nothing_to_restore'
  | 'not_current'
  | 'no_approval'
  | 'not_unknown';

export type Refusal = { ok: false; refusal: ReleaseRefusal; message: string };
const no = (refusal: ReleaseRefusal, message: string): Refusal => ({ ok: false, refusal, message });

function approverRefusal(a: ApproverFacts): Refusal | null {
  if (a.isAgent) return no('agent_actor', 'AI・自動処理の利用者は承認できません');
  if (a.role !== 'approver') return no('role', '承認できるのは承認者だけです');
  return null;
}

/** head が変わった・PR が閉じられたなど、同じ job ではもう merge できない理由。 */
export const MERGE_EXPIRED_DETAILS: readonly string[] = ['head_changed', 'pr_closed', 'not_own', 'base_changed'];

export interface MergeFacts {
  approver: ApproverFacts;
  jobState: JobState;
  jobHeadSha: string | null;
  requestedHeadSha: string;
  superseded: boolean;
  orderCurrent: boolean;
  verdict: VerificationVerdict['verdict'];
  acAllConfirmed: boolean;
  hasPr: boolean;
  mergeState: MergeState;
  mergeDetail: string | null;
  /** merge_state='sending' が新しい（別の押下が送信中）。 */
  sendingFresh: boolean;
  /** 記録済みの merge の承認の head。 */
  approvedHeadSha: string | null;
}

export type MergeDecision =
  | Refusal
  /** send: GitHub へ送る前に PR を読む。 */
  | { ok: true; mode: 'send' }
  /** unknown / sending の続き。PR を読んで照合するだけ。merge を送らず、新しい承認を残さない。 */
  | { ok: true; mode: 'reconcile' }
  /** すでに merge 済み。押し直しは同じ結果を返す。 */
  | { ok: true; mode: 'already_merged' };

export function decideMerge(f: MergeFacts): MergeDecision {
  const who = approverRefusal(f.approver);
  if (who) return who;
  if (f.jobState === 'merged' || f.jobState === 'staged') {
    return f.requestedHeadSha === f.jobHeadSha
      ? { ok: true, mode: 'already_merged' }
      : no('head_changed', '承認した SHA がこの job の SHA と違います');
  }
  if (f.jobState !== 'pr_ready') return no('state', `いまの状態（${f.jobState}）の job は承認できません`);
  if (!f.jobHeadSha || f.requestedHeadSha !== f.jobHeadSha) {
    return no('head_changed', '表示していた SHA が古くなりました（承認は失効しました）');
  }
  if (f.mergeState === 'sending' && f.sendingFresh) return no('in_progress', '別の操作が merge を進めています');
  if (f.mergeState === 'rejected' && f.mergeDetail !== null && MERGE_EXPIRED_DETAILS.includes(f.mergeDetail)) {
    return no('expired', '前回の merge で承認が失効しました。注文書の版を上げて作り直してください');
  }
  // 結果不明の merge は、版が変わっていても照合して記録する。実際には merge 済みかもしれない
  // 照合では送らない。未 merge なら結果不明を解消し、次の押下を送信の判定へ通す
  if (f.mergeState === 'unknown' || f.mergeState === 'sending') {
    if (!f.hasPr) return no('no_pr', '実 PR の記録がありません');
    return { ok: true, mode: 'reconcile' };
  }
  if (f.superseded) return no('superseded', '新しい版に置きかえられた job は承認できません');
  if (!f.orderCurrent) return no('order_not_current', '注文書が無効になっているため承認できません');
  if (f.verdict !== 'passed' || !f.acAllConfirmed) {
    return no('verification', 'この SHA の検査が合格していません（失敗、skip、未確認、証跡の欠落のいずれか）');
  }
  if (!f.hasPr) return no('no_pr', '実 PR の記録がありません');
  return { ok: true, mode: 'send' };
}

/* ────────────────────────────── merge の承認の記録と失効 ────────────────────────────── */

/** 承認の行の要点（seq の順）。行は追記のみで、取消も行として残る。 */
export interface MergeApprovalFact {
  decision: 'approved' | 'revoked';
  sha: string;
}

/** 効いている承認か。最後の取消より後にあり、対象の head のものだけ（押した人ごとに複数ありうる）。 */
export function hasActiveMergeApproval(rows: readonly MergeApprovalFact[], headSha: string | null): boolean {
  const last = rows[rows.length - 1];
  return last !== undefined && last.decision === 'approved' && last.sha === headSha;
}

export type MergeApprovalStatus = 'effective' | 'used' | 'revoked' | 'expired_head' | 'expired_version' | 'revocation';

export interface MergeApprovalContext {
  jobHeadSha: string | null;
  merged: boolean;
  superseded: boolean;
  orderCurrent: boolean;
  /** PR の head が変わったなど、merge の送信で失効が分かった。 */
  headExpired: boolean;
}

/** 行ごとの見え方（純関数）。古い承認が効いているように見せない。 */
export function mergeApprovalStatuses(rows: readonly MergeApprovalFact[], ctx: MergeApprovalContext): MergeApprovalStatus[] {
  let lastRevoke = -1;
  rows.forEach((r, i) => {
    if (r.decision === 'revoked') lastRevoke = i;
  });
  return rows.map((r, i) => {
    if (r.decision === 'revoked') return 'revocation';
    if (i < lastRevoke) return 'revoked';
    if (r.sha !== ctx.jobHeadSha || ctx.headExpired) return 'expired_head';
    if (ctx.merged) return 'used';
    if (ctx.superseded || !ctx.orderCurrent) return 'expired_version';
    return 'effective';
  });
}

export interface RevokeFacts {
  approver: ApproverFacts;
  jobState: JobState;
  requestedHeadSha: string;
  mergeState: MergeState;
  sendingFresh: boolean;
  approvals: readonly MergeApprovalFact[];
}

/** 取消。GitHub へ送信中は結果を止められないので断る。merge の後は取り消せない（戻しは配備の戻しで行う）。 */
export function decideRevoke(f: RevokeFacts): { ok: true } | Refusal {
  const who = approverRefusal(f.approver);
  if (who) return who;
  if (f.jobState !== 'pr_ready') return no('state', `いまの状態（${f.jobState}）の job の承認は取り消せません`);
  if (f.mergeState === 'sending' && f.sendingFresh) return no('in_progress', '別の操作が merge を進めています');
  if (!hasActiveMergeApproval(f.approvals, f.requestedHeadSha)) return no('no_approval', '取り消せる承認がありません');
  return { ok: true };
}

export interface DeployFacts {
  approver: ApproverFacts;
  jobState: JobState;
  superseded: boolean;
  orderCurrent: boolean;
  mergeSha: string | null;
  treeMatch: boolean | null;
  imageDigest: string | null;
  artifactHealth: boolean | null;
  artifactSmoke: boolean | null;
  environment: string;
  requested: { sha: string; digest: string; environment: string };
}

export function decideDeploy(f: DeployFacts): { ok: true } | Refusal {
  const who = approverRefusal(f.approver);
  if (who) return who;
  if (f.jobState !== 'merged') return no('state', `いまの状態（${f.jobState}）の job は配備を承認できません`);
  if (f.superseded) return no('superseded', '新しい版に置きかえられた job は配備できません');
  if (!f.orderCurrent) return no('order_not_current', '注文書が無効になっているため配備できません');
  if (f.treeMatch !== true) {
    return no('tree_mismatch', 'merge 後の内容が検査した内容と一致していないので配備できません');
  }
  if (!f.mergeSha || f.requested.sha !== f.mergeSha) return no('sha_mismatch', 'SHA が merge の記録と違います');
  if (!f.imageDigest || f.artifactHealth !== true || f.artifactSmoke !== true) {
    return no('no_artifact', '検査済みの成果物がまだありません');
  }
  if (f.requested.digest !== f.imageDigest) return no('digest_mismatch', 'digest が成果物の記録と違います');
  if (f.requested.environment !== f.environment) return no('environment_mismatch', '環境が配備先と違います');
  return { ok: true };
}

export interface RollbackFacts {
  approver: ApproverFacts;
  jobState: JobState;
  imageDigest: string | null;
  previousDigest: string | null;
  /** 環境にいま載っている digest。 */
  environmentDigest: string | null;
}

export function decideRollback(f: RollbackFacts): { ok: true } | Refusal {
  const who = approverRefusal(f.approver);
  if (who) return who;
  if (f.jobState !== 'staged') return no('state', `いまの状態（${f.jobState}）の job は戻せません`);
  if (!f.imageDigest || f.environmentDigest !== f.imageDigest) {
    return no('not_current', 'この job の版は環境に載っていません（戻し済みか、別の版が配備されています）');
  }
  if (!f.previousDigest) return no('nothing_to_restore', '戻す先の版がありません');
  return { ok: true };
}

/** /healthz の応答が SHA と一致するか（version または commit）。 */
export function healthMatches(body: unknown, sha: string): boolean {
  const b = body as { version?: unknown } | null;
  return typeof b?.version === 'string' && b.version === sha;
}

/** `/length?text=abc` の応答が 3 か。JSON の { length: 3 }・数値・文字列の 3 を受ける。 */
export function smokeMatches(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '3') return true;
  try {
    const parsed = JSON.parse(trimmed) as { length?: unknown } | null;
    return parsed?.length === 3;
  } catch {
    return false;
  }
}

/* ────────────────────────────── 画面向けの証跡 ────────────────────────────── */

export interface ReleaseApprovalView {
  kind: 'merge' | 'deploy' | 'rollback';
  decision: 'approved' | 'revoked';
  /** merge の行だけ。効いているか、なぜ失効したか。 */
  status: MergeApprovalStatus | null;
  /** 依頼の起票者または投入した人。 */
  requesterName: string | null;
  repo: string | null;
  prNumber: number | null;
  verifiedRunId: string | null;
  verifiedRunAttempt: number | null;
  approverName: string;
  sha: string;
  digest: string | null;
  environment: string | null;
  reason: string | null;
  decidedAt: string;
}

export interface ReleaseAttemptView {
  kind: 'build' | 'deploy' | 'rollback';
  state: 'pending' | 'running' | 'succeeded' | 'failed';
  sha: string;
  digest: string | null;
  previousDigest: string | null;
  health: boolean | null;
  smoke: boolean | null;
  url: string | null;
  errorCode: string | null;
  autoRollback: 'restored' | 'nothing_to_restore' | 'failed' | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AcResultView {
  acId: string;
  mark: string;
  ciRunId: string | null;
}

export interface ReleaseEvidence {
  repo: string | null;
  prNumber: number | null;
  headSha: string | null;
  mergeState: MergeState;
  /** 内部エラーの本文ではなく、決まった語だけ。 */
  mergeDetail: string | null;
  mergeSha: string | null;
  treeMatch: boolean | null;
  imageDigest: string | null;
  /** 成果物の取得元（合否の根拠にした CI の run）。 */
  artifactRunId: string | null;
  artifactRunAttempt: number | null;
  artifactId: number | null;
  artifactTarSha256: string | null;
  artifactBuiltAt: string | null;
  artifactHealth: boolean | null;
  artifactSmoke: boolean | null;
  environment: string;
  deployedAt: string | null;
  health: boolean | null;
  smoke: boolean | null;
  url: string | null;
  previousDigest: string | null;
  currentDigest: string | null;
  rolledBackAt: string | null;
  /** 環境にいま載っている digest（別の job の版のこともある）。 */
  environmentDigest: string | null;
  /** 環境にいま載っている版の URL（host から届く内部ネットワークの IP）。 */
  environmentUrl: string | null;
  ac: AcResultView[];
  acVerdict: VerificationVerdict['verdict'] | null;
  approvals: ReleaseApprovalView[];
  attempts: ReleaseAttemptView[];
}

export interface DevlineSummary {
  /** 止まっている job（stopped / failed）と、配備か戻しが失敗したままの job。 */
  stopped: number;
  /** 人の merge 判断を待っている job（pr_ready・版が有効・実 PR あり・merge 未了）。 */
  mergeWaiting: number;
}
