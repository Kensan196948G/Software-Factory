/**
 * 開発ライン Phase 1 fake 縦断 PoC の契約（型・定数・純関数）。
 *
 * 根拠: docs/devline/adr-001-devline-foundation.md / docs/devline/api-contract.md
 * 正本: 詳細仕様書 V1.0 4-2, 4-3, 4-5, 4-8, 6-4, 6-6, 6-7
 *
 * このファイルは web からも読めるため、node:crypto・zod・DB を読み込まない。
 * ハッシュの計算（sha256）は API／worker 側で行う: createHash('sha256').update(text, 'utf8').digest('hex')
 */
import type { Role, Signal, Status } from './domain.js';
import { buildOrderYaml } from './order.js';
import type { OrderContext } from './order.js';

/* ────────────────────────────── job 状態（ENT-08・仕様 4-3） ────────────────────────────── */

export const JOB_STATES = [
  'queued',
  'planning',
  'implementing',
  'verifying',
  'revising',
  'pr_ready',
  'reviewing',
  'approved',
  'merged',
  'staged',
  'released',
  'closed',
  'stopped',
  'failed',
  'cancelled',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/**
 * 遷移表（仕様 4-3 をそのまま写したもの）。
 * db/migrations/0008 の devline_job_transition_allowed と一致させる（試験 T-02）。
 * 0014（自動マージ）で pr_ready → stopped と stopped → pr_ready を追加した。仕様 4-3 への追加で、
 * 明示設定された自動マージの失敗だけが pr_ready から stopped へ進む（docs/devline/real-runner.md 17 章）。
 *
 * - 実行中の取消の行き先は stopped（仕様に実行中 → cancelled は無い。ADR D-05）。
 * - stopped / failed / cancelled の行き先は「人の指示の再開先」と closed（ADR D-06）。
 */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['planning', 'cancelled'],
  planning: ['implementing', 'stopped'],
  implementing: ['verifying', 'stopped', 'failed'],
  verifying: ['pr_ready', 'revising', 'stopped'],
  revising: ['verifying', 'stopped'],
  pr_ready: ['reviewing', 'approved', 'stopped'],
  reviewing: ['approved', 'revising', 'stopped'],
  approved: ['merged'],
  merged: ['staged'],
  staged: ['released'],
  released: ['closed'],
  closed: [],
  stopped: ['planning', 'implementing', 'verifying', 'revising', 'reviewing', 'pr_ready', 'closed'],
  failed: ['implementing', 'closed'],
  cancelled: ['queued', 'closed'],
};

export function isJobState(value: string): value is JobState {
  return (JOB_STATES as readonly string[]).includes(value);
}

export function isJobTransitionAllowed(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** 停止系。理由・残作業の記録が必須で、人の指示でしか動かない。 */
export const JOB_HALTED_STATES: readonly JobState[] = ['stopped', 'failed', 'cancelled'];

/** worker が lease を取って進めてよい状態。 */
export const JOB_RUNNABLE_STATES: readonly JobState[] = ['queued', 'planning', 'implementing', 'revising', 'verifying'];

/** 人の取消で動かせる実行中の状態（行き先は stopped）。queued は cancelled へ直接動かす。 */
export const JOB_STOPPABLE_STATES: readonly JobState[] = ['planning', 'implementing', 'verifying', 'revising', 'reviewing'];

/** Phase 1 が到達してよい最後の状態。ここから先へ進めるコードを今回は作らない。 */
export const PHASE1_FINAL_STATE: JobState = 'pr_ready';

const PHASE1_REACHABLE: readonly JobState[] = [
  'queued',
  'planning',
  'implementing',
  'verifying',
  'revising',
  'pr_ready',
  'stopped',
  'failed',
  'cancelled',
];

/** Phase 1 のサービス層が実行してよい遷移か（DB の遷移表より狭い）。 */
export function isPhase1Transition(from: JobState, to: JobState): boolean {
  return isJobTransitionAllowed(from, to) && PHASE1_REACHABLE.includes(from) && PHASE1_REACHABLE.includes(to);
}

/* ────────────────────────────── 停止理由と再開 ────────────────────────────── */

export const STOP_REASONS = [
  'cancel_requested',
  'order_superseded',
  'order_invalidated',
  'same_cause_limit',
  'repair_total_limit',
  'session_limit',
  'continuous_limit',
  'ci_rerun_limit',
  'ci_incomplete',
  'budget_limit',
  'policy_violation',
  'human_approval_required',
  'red_signal_human_required',
  'planning_question',
  'lease_lost_repeatedly',
  'runner_failure',
  'runner_rejected',
  'human_stop',
  // 明示設定された自動マージ（DEVLINE_AUTO_MERGE=1）の失敗。人の承認の経路は従来どおり残る
  'auto_merge_failed',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/**
 * 再開しても同じ停止に戻るか、再開の前に人の判断（再承認など）が要る理由。
 * 修正回数は注文書の再承認（= 新しい版の job）でだけ戻る（仕様 4-5）。
 */
export const NON_RESUMABLE_STOP_REASONS: readonly StopReason[] = [
  'order_superseded',
  'order_invalidated',
  'same_cause_limit',
  'repair_total_limit',
  'ci_rerun_limit',
  'budget_limit',
  'policy_violation',
  'human_approval_required',
  'red_signal_human_required',
  'runner_rejected',
];

/**
 * 実 PR の後始末（純関数）。AI の候補 PR を、merge してよいように見える形で残さない。
 * - 古い版・無効な注文書・cancelled・再開できない停止 → 閉じる（人は読めるし開き直せる）
 * - 再開できる停止 → 開いたまま「止まっている」印を付ける（再開して pr_ready に戻れば本文が更新される）
 * - それ以外 → 何もしない
 */
export type PrFollowup = 'close' | 'mark_stopped' | 'none';

export function prFollowupOf(job: {
  state: JobState;
  stopReason: StopReason | null;
  superseded: boolean;
  orderCurrent: boolean;
}): PrFollowup {
  if (job.state === 'pr_ready') return job.superseded || !job.orderCurrent ? 'close' : 'none';
  if (!JOB_HALTED_STATES.includes(job.state)) return 'none';
  if (job.state === 'cancelled' || job.superseded || !job.orderCurrent) return 'close';
  return job.stopReason !== null && NON_RESUMABLE_STOP_REASONS.includes(job.stopReason) ? 'close' : 'mark_stopped';
}

export type ResumeDecision = { ok: true; to: JobState } | { ok: false; code: 'ERR-201'; reason: string };

/** 再開の可否（純関数）。注文書がまだ有効かは呼び出し側が isOrderCurrent で別に確かめる（無効なら ERR-202）。 */
export function resumeDecision(job: {
  state: JobState;
  stopReason: StopReason | null;
  resumeTo: JobState | null;
}): ResumeDecision {
  if (!JOB_HALTED_STATES.includes(job.state)) {
    return { ok: false, code: 'ERR-201', reason: '停止していないジョブは再開できません' };
  }
  if (job.stopReason && NON_RESUMABLE_STOP_REASONS.includes(job.stopReason)) {
    return {
      ok: false,
      code: 'ERR-201',
      reason: `この理由（${job.stopReason}）の停止は再開できません。注文書の見直しや再承認が必要です`,
    };
  }
  if (!job.resumeTo || job.resumeTo === 'closed' || !isJobTransitionAllowed(job.state, job.resumeTo)) {
    return { ok: false, code: 'ERR-201', reason: '再開先が記録されていません' };
  }
  return { ok: true, to: job.resumeTo };
}

export type CancelDecision =
  | { ok: true; alreadyDone: boolean; to: JobState; stopReason: StopReason | null }
  | { ok: false; code: 'ERR-201'; reason: string };

/**
 * 取消の可否（純関数）。
 * queued → cancelled、実行中 → stopped(cancel_requested)。
 * pr_ready は仕様 4-3 に停止の行き先が無いので受けない（ADR の未確定事項 U-02）。
 */
export function cancelDecision(state: JobState): CancelDecision {
  if (state === 'queued') return { ok: true, alreadyDone: false, to: 'cancelled', stopReason: 'cancel_requested' };
  if (JOB_STOPPABLE_STATES.includes(state))
    return { ok: true, alreadyDone: false, to: 'stopped', stopReason: 'cancel_requested' };
  if (state === 'stopped' || state === 'cancelled') return { ok: true, alreadyDone: true, to: state, stopReason: null };
  return { ok: false, code: 'ERR-201', reason: `いまの状態（${state}）のジョブは取り消せません` };
}

/**
 * worker やサービスが止めるときの行き先（純関数）。仕様 4-3 に沿う。
 * queued に stopped への遷移は無いので cancelled。failed へ行けるのは implementing の runner 失敗だけ。
 * 止める遷移が無い状態（pr_ready 以降・停止系）は null で、状態を動かさない。
 * 例外は自動マージの失敗（`auto_merge_failed`）だけで、pr_ready から stopped へ進める（0014。
 * 人の取消 `cancelRequested` は pr_ready を受けないまま）。
 */
export function haltTarget(state: JobState, reason: StopReason): 'stopped' | 'failed' | 'cancelled' | null {
  if (state === 'queued') return 'cancelled';
  if (state === 'implementing' && reason === 'runner_failure') return 'failed';
  if (state === 'pr_ready' && reason === 'auto_merge_failed') return 'stopped';
  return JOB_STOPPABLE_STATES.includes(state) ? 'stopped' : null;
}

/* ────────────────────────────── 受付12状態との対応（仕様 4-2） ────────────────────────────── */

/**
 * 受付の状態で見て、その job 状態のときに受付がとりうる状態（表示と試験のための参照）。
 * 受付と job は別管理で、worker は request.status を書きかえない（ADR D-07）。
 * 仕様 4-2 の工程の対応から導く。停止系は受付の状態を動かさないので、実行中と同じ範囲を返す。
 */
export const JOB_STATE_REQUEST_STATUSES: Readonly<Record<JobState, readonly Status[]>> = {
  queued: ['approved'],
  planning: ['approved', 'dev'],
  implementing: ['approved', 'dev'],
  verifying: ['approved', 'dev'],
  revising: ['approved', 'dev'],
  pr_ready: ['approved', 'dev', 'verify'],
  reviewing: ['verify'],
  approved: ['verify'],
  merged: ['verify', 'field'],
  staged: ['verify', 'field', 'release_wait'],
  released: ['done'],
  closed: ['done'],
  stopped: ['approved', 'dev', 'verify'],
  failed: ['approved', 'dev', 'verify'],
  cancelled: ['approved', 'dev', 'verify'],
};

/** 依頼がこの状態なら、同じ版の job は進めてよい（承認が生きている）。 */
export const ORDER_LIVE_STATUSES: readonly Status[] = ['approved', 'dev', 'verify', 'field', 'release_wait', 'done'];

/** 依頼の版が job と同じで、承認が取り消されていないか。worker は毎工程で確かめる。 */
export function isOrderCurrent(input: {
  requestStatus: Status;
  requestDeleted: boolean;
  requestOrderVersion: number;
  jobOrderVersion: number;
}): boolean {
  return (
    !input.requestDeleted &&
    input.requestOrderVersion === input.jobOrderVersion &&
    ORDER_LIVE_STATUSES.includes(input.requestStatus)
  );
}

/* ────────────────────────────── 承認の有効性 ────────────────────────────── */

export interface ApprovalFacts {
  id: string;
  decision: 'approved' | 'returned' | 'held';
  orderVersion: number | null;
  approverUserId: string | null;
  decidedSignal: Signal | null;
  suggestedSignal: Signal | null;
  at: string;
}

export interface HandoffCheckInput {
  requestStatus: Status;
  requestDeleted: boolean;
  requestOrderVersion: number;
  requestSignalDecided: Signal | null;
  /** 最新の approval（`order by at desc, id desc limit 1`）。無ければ null。 */
  latestApproval: ApprovalFacts | null;
  /** API-06 の本文の版。旧ルート（版の指定なし）は null。 */
  requestedOrderVersion: number | null;
}

export type HandoffCheck =
  | { ok: true; approvalId: string; approverUserId: string; suggested: Signal; decided: Signal }
  | { ok: false; code: 'ERR-202' | 'ERR-205'; reason: string };

/**
 * 新しい版を固定してよいか（ADR D-03）。
 * すでに固定済みの版を返すだけの再実行は、ここを通さずに既存の結果を返す。
 */
export function checkOrderForHandoff(input: HandoffCheckInput): HandoffCheck {
  const a = input.latestApproval;
  if (input.requestedOrderVersion !== null && input.requestedOrderVersion !== input.requestOrderVersion) {
    return { ok: false, code: 'ERR-202', reason: '指定された版は最新ではありません' };
  }
  if (input.requestDeleted || input.requestStatus !== 'approved') {
    return { ok: false, code: 'ERR-205', reason: '依頼が承認済みの状態ではありません' };
  }
  if (input.requestOrderVersion < 1 || !input.requestSignalDecided) {
    return { ok: false, code: 'ERR-205', reason: '注文書の版または信号の色がありません' };
  }
  if (!a || a.decision !== 'approved') {
    return { ok: false, code: 'ERR-205', reason: '最新の承認記録が承認ではありません' };
  }
  if (a.orderVersion !== input.requestOrderVersion) {
    return { ok: false, code: 'ERR-205', reason: '承認記録の版が注文書の版と一致しません' };
  }
  if (!a.approverUserId) {
    return { ok: false, code: 'ERR-205', reason: '承認者が利用者IDで確認できません' };
  }
  if (!a.suggestedSignal || a.decidedSignal !== input.requestSignalDecided) {
    return { ok: false, code: 'ERR-205', reason: '承認記録の信号の色が依頼と一致しません' };
  }
  return {
    ok: true,
    approvalId: a.id,
    approverUserId: a.approverUserId,
    suggested: a.suggestedSignal,
    decided: a.decidedSignal,
  };
}

/* ────────────────────────────── 正規化とハッシュの入力（ADR D-02） ────────────────────────────── */

/**
 * canonical_yaml の正規化。NFC、改行は LF、値の中に残った単独 CR は空白（q() の「改行は空白」に合わせる）、
 * 末尾の改行はちょうど1つ。content_sha256 はこの結果の UTF-8 バイト列の sha256。
 */
export function canonicalizeOrderYaml(yaml: string): string {
  const lf = yaml.normalize('NFC').replace(/\r\n/g, '\n').replace(/\r/g, ' ');
  return `${lf.replace(/\n+$/, '')}\n`;
}

/**
 * 版固定に使う YAML を作る（注文書 YAML の形式は変えない）。
 * 時間とともに変わる入力を固定する: status は承認済み、suggested は承認記録の値。
 * 版固定のときに一度だけ呼ぶ。保存した後は再生成して比べない。
 */
export function buildSnapshotYaml(ctx: OrderContext & { approvalSuggested: Signal }): string {
  return canonicalizeOrderYaml(
    buildOrderYaml({
      request: { ...ctx.request, status: 'approved' },
      suggested: ctx.approvalSuggested,
      departmentName: ctx.departmentName,
      catalogToolName: ctx.catalogToolName,
      schemaVersion: ctx.schemaVersion,
    }),
  );
}

/** キー順を固定し、文字列を NFC・LF にした決定的な JSON（envelope_sha256 の入力）。 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.normalize('NFC').replace(/\r\n?/g, '\n');
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key.normalize('NFC')] = walk(obj[key]);
    return out;
  };
  return JSON.stringify(walk(value ?? null));
}

export const ORDER_ENVELOPE_SCHEMA = 'msf.order-envelope/v1';

export interface OrderEnvelopeV1 {
  schema: typeof ORDER_ENVELOPE_SCHEMA;
  request_id: string;
  order_version: number;
  content_sha256: string;
  approval: {
    id: string;
    approver_user_id: string;
    decided_signal: Signal;
    suggested_signal: Signal;
    approved_at: string;
  };
  target_repo_id: string;
  base_sha: string;
  policy_version: string;
  frozen_at: string;
}

/* ────────────────────────────── handoff_intent（IF-03・ADR D-04） ────────────────────────────── */

export const HANDOFF_STATES = ['intent', 'sent', 'succeeded', 'unknown', 'failed'] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

export const HANDOFF_OPS = ['create_issue', 'update_issue'] as const;
export type HandoffOp = (typeof HANDOFF_OPS)[number];

/** db/migrations/0008 の devline_handoff_transition_allowed と一致させる（試験 T-02）。 */
export const HANDOFF_TRANSITIONS: Readonly<Record<HandoffState, readonly HandoffState[]>> = {
  intent: ['sent', 'failed'],
  sent: ['succeeded', 'unknown', 'failed'],
  succeeded: [],
  unknown: ['succeeded', 'sent'],
  failed: ['sent'],
};

export function isHandoffTransitionAllowed(from: HandoffState, to: HandoffState): boolean {
  return HANDOFF_TRANSITIONS[from].includes(to);
}

export const HANDOFF_POLICY = {
  /** 外部呼び出し1回の時間切れ。SENT_STALE より必ず短くする。 */
  httpTimeoutMs: 30_000,
  /** これを過ぎた sent は、応答が失われたものとして照合する。これより新しい sent は別の処理の最中とみなす。 */
  sentStaleMs: 120_000,
  /** 混雑（429）時の再試行の間隔（IF-03）。 */
  retryDelaysMinutes: [1, 5, 15],
  /** 照合の list API の取得範囲。since は intent の作成時刻からこの分だけ前にする（時計のずれ）。 */
  reconcileSinceMarginMinutes: 5,
  reconcilePerPage: 100,
  /** これを超えたら「見つからなかった」と言わず不完全のまま unknown に留める。 */
  reconcileMaxPages: 10,
} as const;

/** 何回目の混雑かに応じた次の試行時刻（3回目以降は最後の間隔）。 */
export function nextRetryAt(now: Date, attemptsSoFar: number): Date {
  const delays = HANDOFF_POLICY.retryDelaysMinutes;
  const index = Math.min(Math.max(attemptsSoFar - 1, 0), delays.length - 1);
  return new Date(now.getTime() + (delays[index] ?? 15) * 60_000);
}

/** Retry-After の上限。読めない大きな値で投入を止め続けない（24 時間）。 */
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

/** 混雑のときの次の試行時刻（純関数）。既定の待ちと Retry-After の遅い方。 */
export function rateLimitedRetryAt(now: Date, attemptsSoFar: number, retryAfterSeconds?: number): Date {
  const byDefault = nextRetryAt(now, attemptsSoFar);
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) return byDefault;
  const byServer = now.getTime() + Math.min(retryAfterSeconds, MAX_RETRY_AFTER_SECONDS) * 1000;
  return new Date(Math.max(byDefault.getTime(), byServer));
}

export type IssueTransportFacts =
  | { kind: 'timeout' }
  | { kind: 'network' }
  | {
      kind: 'http';
      status: number;
      bodyParsed: boolean;
      retryAfterPresent: boolean;
      /** `x-ratelimit-remaining: 0`（primary rate limit の 403 は Retry-After を付けない）。 */
      rateLimitExhausted?: boolean;
    };

export type IssueOutcomeClass = 'succeeded' | 'unknown' | 'failed' | 'rate_limited';

/**
 * 外部応答の分類（純関数）。
 * 2xx でも本文が読めなければ作成済みの可能性があるので unknown。
 * 408・3xx・5xx も unknown。429 と、Retry-After 付きか `x-ratelimit-remaining: 0` の 403 は「未処理」とみなす rate_limited。
 * それ以外の 4xx は確定した失敗（Issue は作られていない）。
 */
export function classifyIssueResponse(facts: IssueTransportFacts): IssueOutcomeClass {
  if (facts.kind !== 'http') return 'unknown';
  const { status, bodyParsed, retryAfterPresent, rateLimitExhausted } = facts;
  if (status >= 200 && status < 300) return bodyParsed ? 'succeeded' : 'unknown';
  if (status === 429 || (status === 403 && (retryAfterPresent || rateLimitExhausted === true))) return 'rate_limited';
  if (status === 408) return 'unknown';
  if (status >= 400 && status < 500) return 'failed';
  return 'unknown';
}

export type HandoffAction = 'return_existing' | 'claim_and_send' | 'send_not_allowed' | 'in_flight' | 'retry_later' | 'reconcile';

/**
 * 既存の intent に対して次に何をするか（純関数）。
 * sendAllowed は「この intent の版が依頼の最新の版で、isOrderCurrent が真」。偽なら外部へ送らない
 * （古い版の PATCH が新しい版を上書きする、取消・差戻しの後に Issue を作る、を防ぐ）。
 * 照合は読み取りだけなので、sendAllowed が偽でも行ってよい。
 */
export function nextHandoffAction(
  intent: { state: HandoffState; sentAt: Date | null; nextAttemptAt: Date | null },
  now: Date,
  context: { sendAllowed: boolean },
): HandoffAction {
  switch (intent.state) {
    case 'succeeded':
      return 'return_existing';
    case 'intent':
      return context.sendAllowed ? 'claim_and_send' : 'send_not_allowed';
    case 'failed':
      if (!context.sendAllowed) return 'send_not_allowed';
      return intent.nextAttemptAt && intent.nextAttemptAt.getTime() > now.getTime() ? 'retry_later' : 'claim_and_send';
    case 'sent':
      return intent.sentAt && now.getTime() - intent.sentAt.getTime() >= HANDOFF_POLICY.sentStaleMs ? 'reconcile' : 'in_flight';
    case 'unknown':
      return 'reconcile';
  }
}

export type AfterNotFound = 'stay_unknown' | 'resend_patch' | 'resend_create';

/**
 * 照合で見つからなかったときの次の手（純関数）。
 * create は権限者の confirm_absent があるときだけ再作成する。走査が途中で切れたら、何があっても再送しない。
 * update は同じ内容で PATCH するだけなので再送できる。どちらも sendAllowed（nextHandoffAction と同じ）のときに限る。
 */
export function afterReconcileNotFound(input: {
  op: HandoffOp;
  scanComplete: boolean;
  confirmAbsent: boolean;
  sendAllowed: boolean;
}): AfterNotFound {
  if (!input.scanComplete || !input.sendAllowed) return 'stay_unknown';
  if (input.op === 'update_issue') return 'resend_patch';
  return input.confirmAbsent ? 'resend_create' : 'stay_unknown';
}

const MARKER_RE =
  /^<!-- msf-handoff:v1 request=(REQ-\d{4}-\d{4}) version=([1-9]\d*) op=(create_issue|update_issue) repo=([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) sha256=([0-9a-f]{64}) -->$/;

export interface HandoffMarker {
  requestId: string;
  orderVersion: number;
  op: HandoffOp;
  repo: string;
  contentSha256: string;
}

export function buildHandoffMarker(m: HandoffMarker): string {
  return `<!-- msf-handoff:v1 request=${m.requestId} version=${m.orderVersion} op=${m.op} repo=${m.repo} sha256=${m.contentSha256} -->`;
}

/** 本文の1行目だけを見る。注文書の文章の中に同じ文字列があっても一致させない。 */
export function parseHandoffMarker(body: string | null | undefined): HandoffMarker | null {
  const firstLine = (body ?? '').split('\n', 1)[0] ?? '';
  const m = MARKER_RE.exec(firstLine.replace(/\r$/, ''));
  if (!m) return null;
  return {
    requestId: m[1] as string,
    orderVersion: Number(m[2]),
    op: m[3] as HandoffOp,
    repo: m[4] as string,
    contentSha256: m[5] as string,
  };
}

export interface IssueSummary {
  number: number;
  url: string;
  body: string | null;
  authorLogin: string | null;
  /** GitHub の issues API は PR も返すので区別する。 */
  isPullRequest: boolean;
}

export interface MarkerMatch {
  found: IssueSummary | null;
  /** 2件以上見つかったときの残りの番号（小さい番号を正とし、残りは記録して人へ）。 */
  duplicates: number[];
}

/**
 * 照合の一致判定（純関数）。リポジトリは公開なので、だれでも同じ文字列の Issue を作れる。
 * そのため PR を除き、作成者が連携アカウント本人のものだけを見る。
 */
export function matchIssueByMarker(issues: readonly IssueSummary[], marker: string, actorLogin: string): MarkerMatch {
  const hits = issues
    .filter((i) => !i.isPullRequest && i.authorLogin === actorLogin)
    .filter((i) => ((i.body ?? '').split('\n', 1)[0] ?? '').replace(/\r$/, '') === marker)
    .sort((a, b) => a.number - b.number);
  return { found: hits[0] ?? null, duplicates: hits.slice(1).map((i) => i.number) };
}

/* ────────────────────────────── 権限（既存の actor 判定の上に載せる） ────────────────────────────── */

export interface DevlineActorFacts {
  role: Role;
  isAdmin: boolean;
}

/** 投入（API-06・旧ルート）。旧ルートと同じ。 */
export function canHandoff(a: DevlineActorFacts): boolean {
  return a.role === 'desk' || a.role === 'approver';
}

/** cancel / resume。 */
export function canOperateJob(a: DevlineActorFacts): boolean {
  return a.role === 'desk' || a.role === 'approver' || a.isAdmin;
}

/** confirm_absent。誤ると Issue が重複するので受付担当には任せない。 */
export function canConfirmAbsent(a: DevlineActorFacts): boolean {
  return a.role === 'approver' || a.isAdmin;
}

/* ────────────────────────────── policy（devline-policy/v1） ────────────────────────────── */

export const POLICY_VERSION = 'devline-policy/v1';

/**
 * 実行上限。仕様 4-5 の（案）と本セッションの指示の厳しい側。注文書の本文では上書きできない。
 * 回数はいずれも「すでに行った回数」がこの値に達したら次を行わない。
 */
export const DEVLINE_POLICY = {
  version: POLICY_VERSION,
  /** 同じ原因の修正（仕様の案は3回） */
  maxSameCauseRepairs: 2,
  /** 1タスクの修正の合計（仕様の案は6回）。注文書の再承認（新しい版の job）で戻る。 */
  maxTotalRepairs: 5,
  /** 1セッション */
  maxSessionMinutes: 60,
  /** 連続作業時間 */
  maxContinuousMinutes: 120,
  /** 同じコミットの CI 再実行 */
  maxCiRerunsPerCommit: 2,
  /** 予算は未設定（null）。実 AI を動かさない理由。fake の費用は 0 円で計上だけする。 */
  budgetJpy: null as number | null,
  budgetWarnRatio: 0.8,
  /** lease の既定の長さと、取り直しの上限。 */
  leaseSeconds: 300,
  maxLeaseReclaims: 3,
} as const;

export type RepairDecision = { allow: true } | { allow: false; stopReason: 'same_cause_limit' | 'repair_total_limit' };

export function decideRepair(
  counters: { total: number; byCause: Readonly<Record<string, number>> },
  causeKey: string,
): RepairDecision {
  if ((counters.byCause[causeKey] ?? 0) >= DEVLINE_POLICY.maxSameCauseRepairs) {
    return { allow: false, stopReason: 'same_cause_limit' };
  }
  if (counters.total >= DEVLINE_POLICY.maxTotalRepairs) return { allow: false, stopReason: 'repair_total_limit' };
  return { allow: true };
}

/** 原因のキー。CI の結果（段階とテストID）から作り、Agent の申告を使わない。順序に左右されない。 */
export function failureCauseKey(failedStages: readonly string[], failedTestIds: readonly string[]): string {
  return `${[...failedStages].sort().join(',')}|${[...failedTestIds].sort().join(',')}`;
}

/** 時間の上限（ちょうどで止める）。時刻は引数で受ける。 */
export function checkTimeLimits(input: {
  now: Date;
  sessionStartedAt: Date | null;
  continuousSeconds: number;
}): { stopReason: 'session_limit' | 'continuous_limit' } | null {
  const session = input.sessionStartedAt ? Math.max(0, (input.now.getTime() - input.sessionStartedAt.getTime()) / 1000) : 0;
  if (input.continuousSeconds + session >= DEVLINE_POLICY.maxContinuousMinutes * 60) return { stopReason: 'continuous_limit' };
  if (session >= DEVLINE_POLICY.maxSessionMinutes * 60) return { stopReason: 'session_limit' };
  return null;
}

export function isCiRerunAllowed(rerunsSoFar: number): boolean {
  return rerunsSoFar < DEVLINE_POLICY.maxCiRerunsPerCommit;
}

/** 対象リポジトリの許可リスト。完全一致のみ。 */
export function isRepoAllowed(repo: string, allowList: readonly string[]): boolean {
  return allowList.includes(repo);
}

/**
 * 開発ラインの投入を許可するリポジトリ（ADR 11章）。repoId は GitHub の数値 ID で、
 * 名前の付け替えや譲渡で別のリポジトリへ送らないよう、送信の前に照合する。
 */
export interface AllowedRepo {
  name: string;
  repoId: string;
}

const REPO_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `owner/name:repoId` のカンマ区切りを解釈する。未設定や空は「すべて拒否」。形が違う値は設定の誤りとして例外にする。 */
export function parseDevlineTargetRepos(raw: string | null | undefined): AllowedRepo[] {
  const repos: AllowedRepo[] = [];
  for (const part of (raw ?? '').split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    const colon = entry.lastIndexOf(':');
    const name = colon > 0 ? entry.slice(0, colon) : '';
    const repoId = colon > 0 ? entry.slice(colon + 1) : '';
    if (!REPO_NAME_RE.test(name) || name.split('/').some((s) => /^\.+$/.test(s)) || !/^[1-9]\d*$/.test(repoId)) {
      throw new Error('DEVLINE_TARGET_REPOS の形が正しくありません（owner/name:repoId のカンマ区切り）');
    }
    repos.push({ name, repoId });
  }
  return repos;
}

/** 変更してよい場所（前方一致）。ここに無い場所（db/migrations、package.json ほか）は拒否。 */
export const ALLOWED_PATH_PREFIXES: readonly string[] = ['src/', 'tests/', 'docs/orders/'];

/** 変更してはいけない場所（FR-34, FR-46）。正規化して小文字にした path で判定する。許可より優先。 */
export const FORBIDDEN_PATH_PATTERNS: readonly RegExp[] = [
  // CI 定義・保護ルール
  /^\.github\//,
  /^\.gitlab-ci/,
  /^\.husky\//,
  // secret 類
  /(^|\/)\.env($|\.|rc$)/,
  /\.env$/,
  /\.(pem|key|p12|pfx|jks|kdbx|keystore)$/,
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)($|\.)/,
  /(^|\/)\.?(secrets?|credentials?)($|[./])/,
  /(^|\/)\.(ssh|aws|gnupg)\//,
  /(^|\/)\.(npmrc|netrc|pgpass)$/,
  /(^|\/)local\.json$/,
  // 認証
  /^src\/api\/(auth|password|config)\.ts$/,
  // 工場自体の定義。policy・遷移表・信号ルール・注文書のひな形・実行者・監査を自分で書きかえさせない（FR-46）
  /^src\/shared\/(devline|domain|order)\.ts$/,
  /^src\/worker\//,
  /^src\/api\/(devline-[^/]*|issue-adapter[^/]*|github|service|app|http|audit|db)\.ts$/,
  // 配備定義
  /(^|\/)wrangler\.(toml|json|jsonc)$/,
  /(^|\/)dockerfile/,
  /(^|\/)(docker-)?compose[^/]*\.ya?ml$/,
  /(^|\/)(deploy|deployment|infra|terraform|k8s|helm|systemd)\//,
  /\.service$/,
  /^scripts\/(deploy|preview|staging|prod)/,
];

/** 正規化。読めない path は null（呼び出し側は違反として扱う）。 */
export function normalizeRepoPath(raw: string): string | null {
  const text = raw.normalize('NFC');

  if (text === '' || /[\u0000-\u001f\u007f\\]/.test(text)) return null;
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) return null;
  const parts: string[] = [];
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length === 0 ? null : parts.join('/');
}

export interface PathViolation {
  path: string;
  rule: 'invalid_path' | 'forbidden' | 'not_allowed';
}

/** 変更された path の検査（純関数）。1件でも違反があれば job は stopped(policy_violation)。 */
export function checkChangedPaths(paths: readonly string[]): PathViolation[] {
  const violations: PathViolation[] = [];
  for (const raw of paths) {
    const path = normalizeRepoPath(raw);
    if (path === null) {
      violations.push({ path: raw, rule: 'invalid_path' });
      continue;
    }
    // 禁止は大小文字の違いでもすり抜けさせない。許可は完全一致（`SRC/` は別の場所）
    if (FORBIDDEN_PATH_PATTERNS.some((re) => re.test(path.toLowerCase()))) {
      violations.push({ path, rule: 'forbidden' });
    } else if (!ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      violations.push({ path, rule: 'not_allowed' });
    }
  }
  return violations;
}

/** 新しい試験の置き場。これ以外の tests/ は既存の試験の変更とみなす。 */
export const NEW_TEST_PATH_PREFIX = 'tests/generated/';

/**
 * 人の承認が要る変更（純関数）。既存の試験を書きかえて合格にできないようにする。
 * git の差分が無いので新規か既存かは置き場で判定する（実 runner の課題。ADR 11章）。
 */
export function pathsRequiringHumanApproval(paths: readonly string[]): string[] {
  const hits: string[] = [];
  for (const raw of paths) {
    const path = normalizeRepoPath(raw);
    if (path !== null && path.startsWith('tests/') && !path.startsWith(NEW_TEST_PATH_PREFIX)) hits.push(path);
  }
  return hits;
}

/* ────────────────────────────── リポジトリごとの差分 policy（docker-claude） ────────────────────────────── */

/**
 * 実 runner の差分検査の規則。工場自身と製品リポジトリで分ける。
 * forbidden は小文字にした path で判定し、許可より優先する。allowed は完全一致の前方一致。
 */
export interface RepoDiffPolicy {
  version: string;
  allowedPrefixes: readonly string[];
  allowedExactPaths: readonly string[];
  forbidden: readonly RegExp[];
  /** ここの既存ファイルの変更・削除は人の承認（新規追加は可）。 */
  protectedTestPrefixes: readonly string[];
  maxFiles: number;
}

/**
 * どのリポジトリでも変更させない場所。ランナーの権限を変えるもの（.claude など）は深さによらず拒否する。
 * clone 後に作業場から除く対象（RUNNER_CONFIG_PATTERNS）もこの一部。
 */
export const RUNNER_CONFIG_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.claude(\/|$)/,
  /(^|\/)\.claude\.json$/,
  /(^|\/)\.mcp\.json$/,
  /(^|\/)claude(\.local)?\.md$/,
];

export const COMMON_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  ...RUNNER_CONFIG_PATTERNS,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.gitmodules$/,
  /(^|\/)\.gitattributes$/,
  /(^|\/)\.github(\/|$)/,
  /^\.gitlab-ci/,
  /^\.husky\//,
  /(^|\/)\.env($|\.|rc$)/,
  /\.env$/,
  /\.(pem|key|p12|pfx|jks|kdbx|keystore)$/,
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)($|\.)/,
  /(^|\/)\.?(secrets?|credentials?)($|[./])/,
  /(^|\/)\.(ssh|aws|gnupg)\//,
  /(^|\/)\.(npmrc|netrc|pgpass)$/,
  /(^|\/)local\.json$/,
  /(^|\/)wrangler\.(toml|json|jsonc)$/,
  /(^|\/)dockerfile/,
  /(^|\/)(docker-)?compose[^/]*\.ya?ml$/,
  /(^|\/)(deploy|deployment|infra|terraform|k8s|helm|systemd)\//,
  /\.service$/,
];

export const FACTORY_DIFF_POLICY: RepoDiffPolicy = {
  version: 'diff-policy/factory-v1',
  allowedPrefixes: ALLOWED_PATH_PREFIXES,
  allowedExactPaths: [],
  forbidden: [...COMMON_FORBIDDEN_PATTERNS, ...FORBIDDEN_PATH_PATTERNS],
  protectedTestPrefixes: ['tests/'],
  maxFiles: 200,
};

/** 製品（Sandbox）。package.json は CI の中身を変えられるので許可しない。 */
export const SANDBOX_DIFF_POLICY: RepoDiffPolicy = {
  version: 'diff-policy/sandbox-v1',
  allowedPrefixes: ['src/', 'test/', 'docs/'],
  allowedExactPaths: ['README.md'],
  forbidden: COMMON_FORBIDDEN_PATTERNS,
  protectedTestPrefixes: ['test/'],
  maxFiles: 200,
};

export const SANDBOX_REPO: AllowedRepo = { name: 'Kensan196948G/Software-Factory-Sandbox', repoId: '1440860477' };

/**
 * 実 runner の許可台帳（コードの定数）。`DEVLINE_TARGET_REPOS` との**積集合**だけが許可される。
 * 1行が1リポジトリで、owner/name・repoId・用途・非公開の前提を持つ。増やすときは
 * docs/devline/repo-onboarding.md の手順（CI の artifact v2 と image、private、repoId の確認、差分 policy の追加）を満たす。
 * ここに載っていないリポジトリは、設定に書いても起動時に拒否する（fail-closed）。
 */
export interface RepoAllowEntry extends AllowedRepo {
  /** 用途。監査と画面・docs に出す（何のために許したか）。 */
  purpose: string;
  /** 非公開のリポジトリだけを載せる。公開リポジトリを受ける例外は作らない。 */
  private: true;
}

export const DEVLINE_REPO_LEDGER: readonly RepoAllowEntry[] = [
  {
    name: SANDBOX_REPO.name,
    repoId: SANDBOX_REPO.repoId,
    purpose: '開発ラインの検証用 Sandbox（作り物の注文書だけを流し、CI が ac-results と image を出す）',
    private: true,
  },
];

/** 台帳の行（名前と repoId の両方が一致するものだけ）。 */
export function ledgerEntryFor(
  repo: string,
  repoId?: string | null,
  ledger: readonly RepoAllowEntry[] = DEVLINE_REPO_LEDGER,
): RepoAllowEntry | null {
  return ledger.find((r) => r.name === repo && (repoId === undefined || repoId === null || r.repoId === repoId)) ?? null;
}

/**
 * 設定（DEVLINE_TARGET_REPOS）と台帳の積集合。順は設定の順（先頭が投入の既定先）。
 * repoId が台帳と違う行は含めない（名前の付け替え・譲渡で別のリポジトリへ送らない）。
 */
export function allowedLedgerRepos(
  configured: readonly AllowedRepo[],
  ledger: readonly RepoAllowEntry[] = DEVLINE_REPO_LEDGER,
): RepoAllowEntry[] {
  const out: RepoAllowEntry[] = [];
  for (const repo of configured) {
    const entry = ledgerEntryFor(repo.name, repo.repoId, ledger);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * 依頼が選んだ投入先（L-12）を、設定と台帳の**積集合**で引く（純関数）。無ければ null。
 * 画面から来た値をそのまま使わず、サーバがここで決め直す（最終正本）。
 * 未指定（空文字・null・undefined）は null を返す（呼び出し側が「既定」と区別する）。
 */
export function findTargetRepoInLedger(
  requested: string | null | undefined,
  configured: readonly AllowedRepo[],
  ledger: readonly RepoAllowEntry[] = DEVLINE_REPO_LEDGER,
): RepoAllowEntry | null {
  const name = (requested ?? '').trim();
  if (name === '') return null;
  return allowedLedgerRepos(configured, ledger).find((r) => r.name === name) ?? null;
}

const REPO_DIFF_POLICIES: Readonly<Record<string, RepoDiffPolicy>> = {
  'Kensan196948G/Software-Factory': FACTORY_DIFF_POLICY,
  [SANDBOX_REPO.name]: SANDBOX_DIFF_POLICY,
};

/** リポジトリの差分 policy。定義の無いリポジトリは null（実 runner は動かさない）。 */
export function diffPolicyForRepo(repo: string): RepoDiffPolicy | null {
  return Object.hasOwn(REPO_DIFF_POLICIES, repo) ? (REPO_DIFF_POLICIES[repo] as RepoDiffPolicy) : null;
}

/**
 * 記録済みの変更 path を、リポジトリの差分 policy で検査する（純関数）。
 * 実 runner は push の前に git の差分（mode・リネーム・中身の秘密・バイナリ）を見て止める。
 * ここはその**証跡**（work_state.changedPaths）を、自動マージの前にもう一度 policy に照らすためのもの。
 */
export function checkRepoChangedPaths(paths: readonly string[], policy: RepoDiffPolicy): PathViolation[] {
  const violations: PathViolation[] = [];
  for (const raw of paths) {
    const path = normalizeRepoPath(raw);
    if (path === null) {
      violations.push({ path: raw.slice(0, 300), rule: 'invalid_path' });
      continue;
    }
    const lower = path.toLowerCase();
    if (policy.forbidden.some((re) => re.test(lower))) {
      violations.push({ path, rule: 'forbidden' });
    } else if (!policy.allowedExactPaths.includes(path) && !policy.allowedPrefixes.some((prefix) => path.startsWith(prefix))) {
      violations.push({ path, rule: 'not_allowed' });
    }
  }
  if (paths.length > policy.maxFiles) violations.push({ path: `${paths.length} files`, rule: 'not_allowed' });
  return violations;
}

export type AutoMergeDiffProblem = 'diff_policy_missing' | 'diff_policy_mismatch' | 'diff_paths_missing' | 'diff_violation';

export type AutoMergeDiffEvidence =
  | { ok: true; policyVersion: string; changedPaths: string[] }
  | { ok: false; problem: AutoMergeDiffProblem; violations?: PathViolation[] };

/**
 * 自動マージの条件3「差分検査（禁止パス・秘密・バイナリ）通過済み」の証跡を確かめる（純関数）。
 * 実 runner はホスト側の差分検査を通った結果に `work_state.diffPolicy`（検査した policy の版）と
 * `work_state.changedPaths` を残す。記録が無い・版が今の policy と違う・policy に反する path は通さない。
 * 中身（秘密・バイナリ）の再走査はしない。それは push の前にホストが行い、ここでは「その検査を通った記録」を根拠にする。
 */
export function checkAutoMergeDiffEvidence(
  repo: string,
  workState: unknown,
  policyOf: (repo: string) => RepoDiffPolicy | null = diffPolicyForRepo,
): AutoMergeDiffEvidence {
  const policy = policyOf(repo);
  const state = (workState ?? {}) as { diffPolicy?: unknown; changedPaths?: unknown };
  if (!policy) return { ok: false, problem: 'diff_policy_missing' };
  if (typeof state.diffPolicy !== 'string' || state.diffPolicy === '') return { ok: false, problem: 'diff_policy_missing' };
  if (state.diffPolicy !== policy.version) return { ok: false, problem: 'diff_policy_mismatch' };
  const rawPaths = state.changedPaths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) return { ok: false, problem: 'diff_paths_missing' };
  const paths = rawPaths.filter((p): p is string => typeof p === 'string');
  if (paths.length !== rawPaths.length) return { ok: false, problem: 'diff_paths_missing' };
  const violations = checkRepoChangedPaths(paths, policy);
  if (violations.length > 0) return { ok: false, problem: 'diff_violation', violations };
  return { ok: true, policyVersion: policy.version, changedPaths: paths };
}

/* ────────────────────────────── 自動マージ（DEVLINE_AUTO_MERGE） ────────────────────────────── */

/**
 * 自動マージのポリシー版。判定の根拠・監査・release の記録に残す。
 * 条件を変えたら版を上げる（どの規約で merge したかを後から辿れるようにする）。
 */
export const AUTO_MERGE_POLICY_VERSION = 'msf.auto-merge/v1';

/** 自動マージが見る merge の途中経過（release.merge_state と同じ語）。 */
export type AutoMergeMergeState = 'none' | 'sending' | 'unknown' | 'rejected' | 'merged';

/** 自動マージを通さない理由。監査と stop_detail に残す。 */
export type AutoMergeRefusal =
  | 'disabled'
  | 'state'
  | 'head_missing'
  | 'superseded'
  | 'order_not_current'
  | 'verification'
  | 'ac_unconfirmed'
  | 'diff_policy_missing'
  | 'diff_policy_mismatch'
  | 'diff_paths_missing'
  | 'diff_violation'
  | 'repo_not_configured'
  | 'repo_not_in_ledger'
  | 'repo_id_mismatch'
  | 'repo_not_private'
  | 'no_pr'
  | 'merge_in_progress'
  | 'merge_rejected';

export interface AutoMergeRepoFacts {
  /** DEVLINE_TARGET_REPOS の行。 */
  configured: AllowedRepo | null;
  /** 台帳の行（名前と repoId が一致するものだけ）。 */
  ledger: RepoAllowEntry | null;
  /** 台帳に名前だけはあるか（repoId の作り替え・譲渡を区別する）。 */
  ledgerNameMatch: boolean;
}

/** リポジトリの許可（設定と台帳の積集合）を自動マージの観点でまとめる（純関数）。 */
export function autoMergeRepoFacts(
  repo: string,
  configured: readonly AllowedRepo[],
  ledger: readonly RepoAllowEntry[] = DEVLINE_REPO_LEDGER,
): AutoMergeRepoFacts {
  const entry = configured.find((r) => r.name === repo) ?? null;
  const byName = ledger.find((r) => r.name === repo) ?? null;
  return {
    configured: entry,
    ledger: entry && byName && byName.repoId === entry.repoId ? byName : null,
    ledgerNameMatch: byName !== null,
  };
}

export interface AutoMergeFacts {
  enabled: boolean;
  jobState: JobState;
  jobHeadSha: string | null;
  superseded: boolean;
  orderCurrent: boolean;
  verdict: VerificationVerdict['verdict'];
  acAllConfirmed: boolean;
  diff: AutoMergeDiffEvidence;
  repo: AutoMergeRepoFacts;
  hasPr: boolean;
  mergeState: AutoMergeMergeState;
}

export type AutoMergeDecision = { ok: true; alreadyMerged: boolean } | { ok: false; reasons: AutoMergeRefusal[] };

/**
 * 自動マージの判定（純関数）。`DEVLINE_AUTO_MERGE=1` のときだけ動く。
 *
 * 次を**すべて**満たすときだけ通す（1つでも欠ければ merge を送らない）:
 * 1. この head の検証が合格し、受入条件が全件確認済み
 * 2. 対象 repo が許可台帳と DEVLINE_TARGET_REPOS の積集合にあり、private 前提である
 * 3. PR の差分検査の証跡（policy の版と変更 path）が今の policy に合う
 * 4. 注文書が最新版で、新しい版に置きかえられていない
 * 5. PR の記録があり、人の merge が進行中・結果不明・却下でない
 * 6. job が pr_ready で、head がある
 *
 * **人の承認の代替ではない**。明示設定されたポリシーによる機械判定で、根拠と設定値は監査に残す。
 */
export function decideAutoMerge(f: AutoMergeFacts): AutoMergeDecision {
  if (!f.enabled) return { ok: false, reasons: ['disabled'] };
  if (f.mergeState === 'merged') return { ok: true, alreadyMerged: true };
  const reasons: AutoMergeRefusal[] = [];
  if (f.jobState !== 'pr_ready') reasons.push('state');
  if (!f.jobHeadSha) reasons.push('head_missing');
  if (f.superseded) reasons.push('superseded');
  if (!f.orderCurrent) reasons.push('order_not_current');
  if (f.verdict !== 'passed') reasons.push('verification');
  if (!f.acAllConfirmed) reasons.push('ac_unconfirmed');
  if (!f.diff.ok) reasons.push(f.diff.problem);
  if (!f.repo.configured) reasons.push('repo_not_configured');
  if (!f.repo.ledger) {
    reasons.push(f.repo.configured && f.repo.ledgerNameMatch ? 'repo_id_mismatch' : 'repo_not_in_ledger');
  }
  if (f.repo.ledger && !f.repo.ledger.private) reasons.push('repo_not_private');
  if (!f.hasPr) reasons.push('no_pr');
  if (f.mergeState === 'sending' || f.mergeState === 'unknown') reasons.push('merge_in_progress');
  if (f.mergeState === 'rejected') reasons.push('merge_rejected');
  return reasons.length === 0 ? { ok: true, alreadyMerged: false } : { ok: false, reasons };
}

/* ────────────────────────────── 実 runner の予算（所有者の決定: 1タスク 1,000 円） ────────────────────────────── */

export const REAL_RUNNER_POLICY = {
  /** 1タスクの上限。これより大きい設定は起動を拒否する（延長しない）。 */
  maxBudgetJpy: 1000,
  /** 為替の既定は安全側（高めの円換算）。 */
  defaultJpyPerUsd: 160,
  budgetWarnRatio: 0.8,
  /**
   * 実 runner を向けてよいリポジトリの台帳。`DEVLINE_TARGET_REPOS` とこの両方に載っていること。
   * 複数可（積集合）。増やす手順は docs/devline/repo-onboarding.md。
   */
  allowedRepos: DEVLINE_REPO_LEDGER as readonly AllowedRepo[],
  /** 検証の根拠にする workflow。 */
  ciWorkflowPath: '.github/workflows/ci.yml',
  ciEvent: 'pull_request',
} as const;

export interface RunnerBudget {
  limitJpy: number;
  jpyPerUsd: number;
}

/** 円の計上は切り上げ（少なく見積もらない）。 */
export function usdToJpyCeil(usd: number, jpyPerUsd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.ceil(Math.round(usd * jpyPerUsd * 1e6) / 1e6);
}

/** --max-budget-usd に渡す額。切り捨てで、0.01 ドル未満は実行しない（null）。 */
export function maxBudgetUsd(budget: RunnerBudget, costJpySoFar: number): number | null {
  const remaining = budget.limitJpy - costJpySoFar;
  if (remaining <= 0) return null;
  const usd = Math.floor((remaining / budget.jpyPerUsd) * 100) / 100;
  return usd >= 0.01 ? usd : null;
}

export type BudgetCheck = { kind: 'ok' | 'warn' } | { kind: 'exceeded' };

/** 費用を足した後の判定。warn は 80% を初めて超えたときだけ。上限ちょうどで止める。 */
export function checkBudget(budget: RunnerBudget, before: number, after: number): BudgetCheck {
  if (after >= budget.limitJpy) return { kind: 'exceeded' };
  const warnAt = budget.limitJpy * REAL_RUNNER_POLICY.budgetWarnRatio;
  return before < warnAt && after >= warnAt ? { kind: 'warn' } : { kind: 'ok' };
}

/* ────────────────────────────── 実 PR のマーカーとブランチ名 ────────────────────────────── */

const PR_MARKER_RE = /^<!-- msf-devline-pr:v1 job=([0-9a-f-]{36}) attempt=([1-9]\d*) head=([0-9a-f]{40}) -->$/;

export interface PrMarker {
  jobId: string;
  attemptNo: number;
  headSha: string;
}

export function buildPrMarker(m: PrMarker): string {
  return `<!-- msf-devline-pr:v1 job=${m.jobId} attempt=${m.attemptNo} head=${m.headSha} -->`;
}

/** 本文の1行目だけを見る（handoff のマーカーと同じ）。 */
export function parsePrMarker(body: string | null | undefined): PrMarker | null {
  const firstLine = (body ?? '').split('\n', 1)[0] ?? '';
  const m = PR_MARKER_RE.exec(firstLine.replace(/\r$/, ''));
  return m ? { jobId: m[1] as string, attemptNo: Number(m[2]), headSha: m[3] as string } : null;
}

/** auto/<REQ番号小文字>-v<版>-a<試行>。main など他の名前を作らない。 */
export function jobBranchName(requestId: string, orderVersion: number, attemptNo: number): string {
  if (!/^REQ-\d{4}-\d{4}$/.test(requestId) || !Number.isInteger(orderVersion) || !Number.isInteger(attemptNo)) {
    throw new Error('ブランチ名の材料が正しくありません');
  }
  return `auto/${requestId.toLowerCase()}-v${orderVersion}-a${attemptNo}`;
}

export const JOB_BRANCH_RE = /^auto\/req-\d{4}-\d{4}-v[1-9]\d*-a[1-9]\d*$/;

/* ────────────────────────────── 検証証跡（ENT-09・仕様 4-5） ────────────────────────────── */

export const REQUIRED_STAGES = ['static', 'build', 'unit', 'integration', 'e2e', 'security'] as const;
export type RequiredStage = (typeof REQUIRED_STAGES)[number];

export const STAGE_STATUSES = ['passed', 'failed', 'skipped', 'cancelled'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const VERIFICATION_SOURCES = ['fake_ci', 'ci', 'github'] as const;
export type VerificationSource = (typeof VERIFICATION_SOURCES)[number];

export interface StageResult {
  stage: string;
  status: StageStatus;
  failedTestIds?: readonly string[];
  logRef?: string | null;
  digest?: string | null;
}

/**
 * AC → test ID の対応。run と SHA と digest は行そのものが持つ。
 * `requestId` / `orderHash` / `testFile` は artifact `msf.ac-results/v2` の証跡。
 * どの依頼の・どのファイルの試験かを示し、v1 の記録には無い（無い記録は合格にしない）。
 */
export interface AcResult {
  acId: string;
  testIds: readonly string[];
  status: 'passed' | 'failed' | 'not_run';
  /** この結果を出した依頼の受付番号（REQ-YYYY-NNNN）。 */
  requestId?: string | null;
  /** 注文書の content_sha256。受付番号の代わりに使ってよい。 */
  orderHash?: string | null;
  /** 試験のあるファイル（リポジトリからの相対パス）。この job の PR で追加・変更されたファイルでなければならない。 */
  testFile?: string | null;
}

export const AC_REQUEST_ID_RE = /^REQ-\d{4}-\d{4}$/;
export const AC_ORDER_HASH_RE = /^[0-9a-f]{64}$/;

/** AC の証跡が属すべき範囲。artifact v2 と、この PR で追加・変更されたファイルから作る。 */
export interface AcEvidenceScope {
  requestId: string;
  orderHash: string;
  /** PR で追加または変更されたファイル（削除は含めない）。 */
  changedFiles: ReadonlySet<string>;
}

/** 試験の置き場所（このリポジトリの約束）。ここ以外を AC の根拠にしない。 */
const AC_TEST_FILE_PREFIX_RE = /^(?:test|tests)\//;

/** リポジトリ相対の試験ファイルの形を確かめ、比較用に正規化する（純関数）。 */
export function normalizeAcTestFile(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.startsWith('./') ? value.slice(2) : value;
  if (path === '' || path.length > 300 || path.trim() === '') return null;
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null;
  // 制御文字を含む名前を認めない（TAP の出力をそのままパスにしない）
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return path;
}

/** 試験ファイルらしい場所か（`test/` または `tests/` の下）。 */
export function isAcTestFile(value: unknown): boolean {
  const path = normalizeAcTestFile(value);
  return path !== null && AC_TEST_FILE_PREFIX_RE.test(path);
}

/**
 * v2 の AC の証跡が、この job の依頼と PR の範囲に属するか（純関数）。
 * 依頼の識別子は受付番号か注文書のハッシュのどちらか一方でよいが、書いてある識別子はすべて一致すること。
 * 試験ファイルは、`test/`（または `tests/`）の下で、この PR で追加または変更されたファイルに含まれること。
 * 範囲が無い・合わない結果は合格にしない（証跡の欠落として扱う）。
 */
export function acEvidenceProblem(result: AcResult, scope: AcEvidenceScope): 'request_mismatch' | 'test_file_mismatch' | null {
  const requestId = typeof result.requestId === 'string' ? result.requestId : null;
  const orderHash = typeof result.orderHash === 'string' ? result.orderHash : null;
  if (requestId === null && orderHash === null) return 'request_mismatch';
  if (requestId !== null && (!AC_REQUEST_ID_RE.test(requestId) || requestId !== scope.requestId)) return 'request_mismatch';
  if (orderHash !== null && (!AC_ORDER_HASH_RE.test(orderHash) || orderHash !== scope.orderHash)) return 'request_mismatch';
  const testFile = normalizeAcTestFile(result.testFile);
  if (testFile === null || !AC_TEST_FILE_PREFIX_RE.test(testFile) || !scope.changedFiles.has(testFile)) {
    return 'test_file_mismatch';
  }
  return null;
}

/** 実 CI の v2 の証跡か（依頼の識別子と試験ファイルがある）。無い記録（v1）は合格にしない。 */
export function hasAcEvidenceScope(result: AcResult): boolean {
  const identified =
    (typeof result.requestId === 'string' && AC_REQUEST_ID_RE.test(result.requestId)) ||
    (typeof result.orderHash === 'string' && AC_ORDER_HASH_RE.test(result.orderHash));
  return identified && isAcTestFile(result.testFile);
}

export interface VerificationRecord {
  deliveryId: string;
  source: VerificationSource;
  ciRunId: string;
  /** CI 側で増える順序番号。到着順は信用しない。 */
  runSequence: number;
  runAttempt: number;
  headSha: string;
  stages: readonly StageResult[];
  acResults: readonly AcResult[];
  reportDigest?: string | null;
}

export type AcMark = '○' | '×' | '未確認';

export interface AcEvidence {
  acId: string;
  mark: AcMark;
  testIds: readonly string[];
  ciRunId: string | null;
  headSha: string | null;
  reportDigest: string | null;
}

export type VerificationVerdict =
  /** 必須段階が全部 passed で、合格の条件が全件 ○。 */
  | { verdict: 'passed'; ciRunId: string; acEvidence: AcEvidence[] }
  /** 実際に失敗した（修正の対象）。 */
  | {
      verdict: 'failed';
      ciRunId: string;
      failedStages: string[];
      /** 走り切っていない必須段階（AC だけ失敗しても CI 成功と言わないため）。 */
      incompleteStages: string[];
      failedAcs: string[];
      failedTestIds: string[];
      causeKey: string;
      acEvidence: AcEvidence[];
    }
  /**
   * 走り切っていない（missing/skipped/cancelled）か、合格の条件に未確認がある。
   * 合格ではないが修正回数は使わず CI 再実行の対象。段階が揃っていて AC だけが未確認のとき incompleteStages は空。
   * 合格の条件が1件も無い注文書は、確かめたものが無いので acMissing=true で incomplete。
   * 報告に注文書に無い AC（unknownAcs）か同じ AC の重複（duplicateAcs）があれば、報告全体を信用せず全件を未確認にする。
   * 実 CI（source='github'）の記録に v2 の範囲（依頼の識別子・試験ファイル）が無いときも、どの依頼の試験か分からないので
   * 全件を未確認にする（v1 の記録を後方互換で合格にしない）。
   */
  | {
      verdict: 'incomplete';
      ciRunId: string;
      incompleteStages: string[];
      unconfirmedAcs: string[];
      acMissing: boolean;
      unknownAcs: string[];
      duplicateAcs: string[];
      /** v2 の範囲情報を持たない結果の AC（v1 の記録・範囲の無い記録）。 */
      unscopedAcs: string[];
      acEvidence: AcEvidence[];
    }
  /** head_sha の結果が無く、古い SHA の結果だけがある。 */
  | { verdict: 'stale'; acEvidence: AcEvidence[] }
  /** 結果がまだ1件も無い。 */
  | { verdict: 'no_result'; acEvidence: AcEvidence[] };

/**
 * 判定（純関数）。head_sha の中で (runSequence, runAttempt) が最大の1件だけで決める。
 * 古い run の成功で新しい失敗を上書きせず、段階を複数の run から寄せ集めもしない。
 * 合格の条件（AC）は test ID の無い passed、not_run、報告の欠落を「未確認」にし、未確認があれば合格にしない。
 * 注文書に無い AC か同じ AC の重複が報告にあれば、どの結果も信用できないので全件「未確認」にする（failed でも修正へ進めない）。
 * pr_ready は「PR 候補の準備完了」であって受入の合格ではない（merge の判断は人）。
 */
/** 合否の根拠にする記録（その head の最新の run と試行）。成果物もこの run のものだけを使う。 */
export function latestVerificationRecord(records: readonly VerificationRecord[], headSha: string): VerificationRecord | null {
  const forHead = records.filter((r) => (VERIFICATION_SOURCES as readonly string[]).includes(r.source) && r.headSha === headSha);
  return [...forHead].sort((a, b) => b.runSequence - a.runSequence || b.runAttempt - a.runAttempt)[0] ?? null;
}

export function evaluateVerification(
  records: readonly VerificationRecord[],
  headSha: string,
  acIds: readonly string[],
): VerificationVerdict {
  const unconfirmed = (): AcEvidence[] =>
    acIds.map((acId) => ({ acId, mark: '未確認', testIds: [], ciRunId: null, headSha: null, reportDigest: null }));
  const trusted = records.filter((r) => (VERIFICATION_SOURCES as readonly string[]).includes(r.source));
  const forHead = trusted.filter((r) => r.headSha === headSha);
  if (forHead.length === 0) {
    return trusted.length > 0
      ? { verdict: 'stale', acEvidence: unconfirmed() }
      : { verdict: 'no_result', acEvidence: unconfirmed() };
  }
  const latest = latestVerificationRecord(trusted, headSha) as VerificationRecord;

  const reported = latest.acResults.map((a) => a.acId);
  const unknownAcs = [...new Set(reported.filter((id) => !acIds.includes(id)))];
  const duplicateAcs = [...new Set(reported.filter((id, i) => reported.indexOf(id) !== i))];
  // 実 CI の記録は artifact v2 の範囲（どの依頼の・どのファイルの試験か）を持つ。
  // v1 の頃に記録した行や範囲の無い行は、どの依頼の試験か分からないので全件を未確認にする。
  const unscopedAcs =
    latest.source === 'github' ? [...new Set(latest.acResults.filter((a) => !hasAcEvidenceScope(a)).map((a) => a.acId))] : [];
  const untrusted = unknownAcs.length > 0 || duplicateAcs.length > 0 || unscopedAcs.length > 0;

  const acEvidence: AcEvidence[] = acIds.map((acId) => {
    const hit = untrusted ? undefined : latest.acResults.find((a) => a.acId === acId);
    const mark: AcMark = !hit
      ? '未確認'
      : hit.status === 'failed'
        ? '×'
        : hit.status === 'passed' && hit.testIds.length > 0
          ? '○'
          : '未確認';
    return {
      acId,
      mark,
      testIds: hit?.testIds ?? [],
      ciRunId: latest.ciRunId,
      headSha: latest.headSha,
      reportDigest: latest.reportDigest ?? null,
    };
  });

  const statusOf = (stage: string): StageStatus | 'missing' => {
    const rows = latest.stages.filter((s) => s.stage === stage);
    if (rows.length === 0) return 'missing';
    // 同じ段階が複数あるときは悪い方を採る
    for (const bad of ['failed', 'cancelled', 'skipped'] as const) {
      if (rows.some((s) => s.status === bad)) return bad;
    }
    return rows.every((s) => s.status === 'passed') ? 'passed' : 'missing';
  };
  const failedStages = REQUIRED_STAGES.filter((s) => statusOf(s) === 'failed');
  const incompleteStages = REQUIRED_STAGES.filter((s) => ['missing', 'skipped', 'cancelled'].includes(statusOf(s)));
  const failedAcs = acEvidence.filter((a) => a.mark === '×');

  if (failedStages.length > 0 || failedAcs.length > 0) {
    const failedTestIds = [
      ...latest.stages.filter((s) => s.status === 'failed').flatMap((s) => s.failedTestIds ?? []),
      ...failedAcs.flatMap((a) => a.testIds),
    ];
    const uniqueTests = [...new Set(failedTestIds)];
    return {
      verdict: 'failed',
      ciRunId: latest.ciRunId,
      failedStages: [...failedStages],
      incompleteStages: [...incompleteStages],
      failedAcs: failedAcs.map((a) => a.acId),
      failedTestIds: uniqueTests,
      // test ID の無い AC の失敗も、AC ごとに別の原因として数える
      causeKey: failureCauseKey(failedStages, uniqueTests.length > 0 ? uniqueTests : failedAcs.map((a) => a.acId)),
      acEvidence,
    };
  }
  const unconfirmedAcs = acEvidence.filter((a) => a.mark !== '○').map((a) => a.acId);
  const acMissing = acIds.length === 0;
  if (incompleteStages.length > 0 || unconfirmedAcs.length > 0 || acMissing) {
    return {
      verdict: 'incomplete',
      ciRunId: latest.ciRunId,
      incompleteStages: [...incompleteStages],
      unconfirmedAcs,
      acMissing,
      unknownAcs,
      duplicateAcs,
      unscopedAcs,
      acEvidence,
    };
  }
  return { verdict: 'passed', ciRunId: latest.ciRunId, acEvidence };
}

/** 合格の条件の ID。注文書の acceptance_criteria と同じく空の行を除いて数える。 */
export function acIdsOf(criteria: readonly string[]): string[] {
  return criteria.filter((c) => c.trim() !== '').map((_, i) => `AC-${i + 1}`);
}

export interface AcSummary {
  total: number;
  confirmed: number;
  failed: number;
  unconfirmed: number;
  /** 画面と PR 本文の文言。「全件確認」は CI の報告が全件 ○ のときだけ。 */
  label: '受入条件 全件確認' | '受入条件 不合格あり' | '受入条件 未確認あり';
}

/** AC の集計（純関数）。条件が0件なら確認していないので「未確認あり」。 */
export function summarizeAc(evidence: readonly AcEvidence[]): AcSummary {
  const confirmed = evidence.filter((a) => a.mark === '○').length;
  const failed = evidence.filter((a) => a.mark === '×').length;
  const unconfirmed = evidence.length - confirmed - failed;
  const label =
    failed > 0 ? '受入条件 不合格あり' : evidence.length > 0 && unconfirmed === 0 ? '受入条件 全件確認' : '受入条件 未確認あり';
  return { total: evidence.length, confirmed, failed, unconfirmed, label };
}

/* ────────────────────────────── Runner adapter ────────────────────────────── */

export const RUNNER_KINDS = ['fake', 'local-isolated', 'real', 'docker-claude'] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

/** 実装済みの runner。これ以外は worker の起動時に拒否する（ERR-405）。 */
export const IMPLEMENTED_RUNNER_KINDS: readonly RunnerKind[] = ['fake', 'docker-claude'];

/** fake のシナリオ。注文書の本文からは選ばせない（テストと worker の設定で注入する）。 */
export const FAKE_SCENARIOS = [
  'success',
  'test_fail_then_fix',
  'same_cause_fail',
  'hang',
  'forbidden_path',
  'injection',
] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

export interface RunnerCapability {
  kind: RunnerKind;
  /** 隔離の実態を正直に申告する。fake は 'none'。 */
  isolation: 'none' | 'process' | 'container' | 'vm';
  network: 'none' | 'allowlist' | 'unrestricted';
  supportsCancel: boolean;
  costAccounting: 'fake_zero' | 'metered';
  /** changedPaths をホストが git の差分から算出する。worker は serverDiff で判定する。 */
  diffCheckedByHost?: boolean;
}

export type RunnerStep = 'plan' | 'implement' | 'revise';

export interface RunnerInput {
  jobId: string;
  attemptNo: number;
  step: RunnerStep;
  /** 注文書はデータとして渡す。ここの文章を命令や policy の上書きとして扱わない（仕様 4-4）。 */
  order: { envelope: OrderEnvelopeV1; canonicalYaml: string };
  acceptanceCriteriaIds: readonly string[];
  policyVersion: string;
  baseSha: string;
  /** revise のときの直前の失敗（CI の結果から作る）。 */
  previousFailure?: {
    failedAcs?: readonly string[];
    note?: string;
    causeKey: string;
    failedStages: readonly string[];
    failedTestIds: readonly string[];
  } | null;
  /** 時刻は引数で渡す。runner は壁時計で判断しない。 */
  deadlineAt: string;
  signal: AbortSignal;
  /** この job がすでに使った費用（円）。残りの予算の計算に使う。 */
  costJpySoFar?: number;
  /** revise の出発点（直前に push した head）。implement では無い。 */
  previousHead?: { sha: string; branch: string } | null;
}

export interface RunnerArtifact {
  kind: 'plan' | 'patch' | 'log' | 'test_report' | 'runner_output';
  name: string;
  sha256: string;
  byteSize: number;
  storageRef?: string | null;
  content?: string | null;
}

export interface RunnerUsage {
  inputTokens: number;
  outputTokens: number;
  durationSeconds: number;
  costJpy: number;
}

export interface RunnerResult {
  status: 'succeeded' | 'failed' | 'needs_human';
  exitCode: number;
  /** implement / revise の成果のコミット。plan は null。 */
  headSha: string | null;
  /** 変更された path。worker は必ず checkChangedPaths を通す。 */
  changedPaths: readonly string[];
  artifacts: readonly RunnerArtifact[];
  logRef: string | null;
  usage: RunnerUsage;
  plan?: unknown;
  /** requires_human_approval に当たる項目。1件でもあれば stopped(human_approval_required)。 */
  humanApprovalTouched?: readonly string[];
  summary: string;
  /**
   * ホスト側の差分検査の結果（docker-claude）。AI の申告ではなく git の差分から算出したもの。
   * capability.diffCheckedByHost の runner でこれが無い結果は worker が拒否する。
   */
  serverDiff?: ServerDiffResult;
  /** CLI が起動していないと確実に分かる（費用なし）。worker は runner_failure の理由に残す。 */
  notStarted?: boolean;
  /** CLI が予算の上限で止まった。worker は費用の合計によらず budget_limit で止める。 */
  budgetExceeded?: boolean;
  /** 費用が実測ではなく見込み（結果を受け取れなかった実行は割り当て分を計上する）。 */
  costEstimated?: boolean;
}

/** ホスト側の差分検査の結果。 */
export interface ServerDiffResult {
  policyVersion: string;
  violations: readonly DiffViolation[];
  /** 既存の試験の変更・削除など、人の承認が要るもの。 */
  humanApproval: readonly string[];
}

export interface DiffViolation {
  path: string;
  rule:
    | 'invalid_path'
    | 'forbidden'
    | 'not_allowed'
    | 'symlink'
    | 'submodule'
    | 'rename_forbidden'
    | 'too_many_files'
    | 'workspace_too_large'
    | 'git_dir_in_worktree'
    | 'unexpected_change'
    | 'secret_detected'
    | 'binary_file'
    | 'file_too_large_to_scan';
  /** secret_detected の検出器の名前。値は入れない。 */
  detector?: string;
  /** secret_detected の行番号（1 始まり）。 */
  line?: number;
}

export interface RunnerAdapter {
  readonly capability: RunnerCapability;
  run(input: RunnerInput): Promise<RunnerResult>;
  /** 冪等。すでに終わっていても失敗しない。 */
  cancel(run: { jobId: string; attemptNo: number }): Promise<void>;
  /** 工程の後始末（作業場の削除）。冪等。 */
  release?(run: { jobId: string; attemptNo: number }): Promise<void>;
}

/* ────────────────────────────── Issue adapter（実 GitHub / ローカル fake で差し替え） ────────────────────────────── */

export type IssueSendOutcome =
  | { outcome: 'succeeded'; number: number; url: string }
  | { outcome: 'unknown'; reason: 'timeout' | 'network' | 'http' | 'bad_response'; httpStatus?: number; message?: string }
  | { outcome: 'failed'; reason: 'http_4xx'; httpStatus: number; message?: string }
  | { outcome: 'rate_limited'; httpStatus: number; retryAfterSeconds?: number };

export interface IssueWriteInput {
  repo: string;
  title: string;
  /** 1行目が buildHandoffMarker の結果であること。 */
  body: string;
  signal: AbortSignal;
}

export interface IssueListPage {
  issues: readonly IssueSummary[];
  nextPage: number | null;
}

export type IssueReadResult<T> =
  { ok: true; value: T } | { ok: false; reason: 'timeout' | 'network' | 'http'; httpStatus?: number };

export interface IssueAdapter {
  readonly kind: 'github' | 'fake';
  /** 連携アカウント。照合の作成者判定に使う。 */
  getActorLogin(signal: AbortSignal): Promise<IssueReadResult<string>>;
  /** リポジトリの数値 ID。許可リストの repoId と照合する（ADR 11章）。 */
  getRepoId(repo: string, signal: AbortSignal): Promise<IssueReadResult<string>>;
  /** 非公開か。公開リポジトリへは投入しない（ADR 11章）。値が読めなければ失敗を返す。 */
  getRepoPrivate(repo: string, signal: AbortSignal): Promise<IssueReadResult<boolean>>;
  /** 既定ブランチの先頭 SHA（base_sha）。 */
  resolveBaseSha(repo: string, signal: AbortSignal): Promise<IssueReadResult<string>>;
  createIssue(input: IssueWriteInput): Promise<IssueSendOutcome>;
  updateIssue(input: IssueWriteInput & { issueNo: number }): Promise<IssueSendOutcome>;
  getIssue(repo: string, issueNo: number, signal: AbortSignal): Promise<IssueReadResult<IssueSummary | null>>;
  /** `state=all`、`since`、昇順のページ送り。search API を使わない。 */
  listIssuesSince(
    input: { repo: string; since: Date; page: number; perPage: number },
    signal: AbortSignal,
  ): Promise<IssueReadResult<IssueListPage>>;
}

/* ────────────────────────────── サービスの結果型 ────────────────────────────── */

export interface HandoffResult {
  requestId: string;
  orderVersion: number;
  issueNo: number;
  issueUrl: string;
  jobId: string;
  jobState: JobState;
  contentSha256: string;
  /** この呼び出しで外部へ作成・更新したか。再実行や照合での回収は false。 */
  created: boolean;
  op: HandoffOp;
}

export interface JobView {
  id: string;
  requestId: string;
  orderVersion: number;
  state: JobState;
  targetRepoId: string;
  policyVersion: string;
  runnerKind: RunnerKind;
  contentSha256: string;
  headSha: string | null;
  plan: unknown;
  workState: unknown;
  repairCountTotal: number;
  repairCountByCause: Record<string, number>;
  ciRerunCount: number;
  continuousSeconds: number;
  costJpy: number;
  stopReason: StopReason | null;
  stopDetail: unknown;
  remainingWork: unknown;
  stoppedAt: string | null;
  cancelRequestedAt: string | null;
  supersededAt: string | null;
  /** いまの依頼に対してこの job の版がまだ有効か（isOrderCurrent）。 */
  orderCurrent: boolean;
  /** lease の所有者名は出さない。 */
  leaseHeld: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * CI の成否（必須段階だけで決める）。success は「CI 成功」で、受入条件の結果でも PR 候補の準備完了でもない。
 * stale は今の head の結果が無く、古い SHA の結果だけがある。
 */
export type CiResult = 'success' | 'failure' | 'incomplete' | 'stale';

/** 判定から CI の成否を取り出す（純関数）。AC の未確認や不合格は CI の成否に混ぜない。 */
export function ciResultOf(verdict: VerificationVerdict): CiResult | null {
  switch (verdict.verdict) {
    case 'passed':
      return 'success';
    case 'failed':
      if (verdict.failedStages.length > 0) return 'failure';
      return verdict.incompleteStages.length > 0 ? 'incomplete' : 'success';
    case 'incomplete':
      return verdict.incompleteStages.length > 0 ? 'incomplete' : 'success';
    case 'stale':
      return 'stale';
    default:
      return null;
  }
}

/** 版ごとの投入の記録（画面用の読み取り）。マーカーと外部の応答の全文は出さない。 */
export interface HandoffView {
  orderVersion: number;
  /** この投入の連携先（読み取りのみ）。今の連携先と違えばここからは照合できない。 */
  targetRepo: string;
  state: HandoffState;
  op: HandoffOp;
  issueNo: number | null;
  issueUrl: string | null;
  /** 連携先の種別。api.github.com 以外（ローカル fake など）は fake。 */
  issueSource: 'github' | 'fake';
  attempts: number;
  nextAttemptAt: string | null;
  updatedAt: string;
}

/** job の証跡の要約（画面の「実行確認済み／fake／未接続」を機械的に決めるため）。 */
export interface JobEvidence {
  attempts: number;
  /** 記録された検証の source。無ければ空。 */
  verificationSources: VerificationSource[];
  hasPrDraft: boolean;
  /** 実 PR（docker-claude）。fake のときや作っていないときは null。 */
  pr?: { number: number; url: string; source: 'github' | 'fake'; closed?: boolean } | null;
  /** source='github' の検証の run URL（新しいものから1件）。 */
  ciRunUrl?: string | null;
  /** source='github' の記録が github.com のものか。 */
  ciSource?: 'github' | 'fake' | null;
  /** 今の head の必須段階の結果（CI の成否）。受入条件の結果は ac で、これには含めない。検証の記録があるときだけ。 */
  ciResult?: CiResult;
  /** 今の head の受入条件の結果。検証の記録があるときだけ。 */
  ac?: AcSummary & { items: { acId: string; mark: AcMark; testIds: readonly string[] }[] };
}

export interface RecordVerificationInput {
  jobId: string;
  deliveryId: string;
  source: VerificationSource;
  ciRunId: string;
  runSequence: number;
  runAttempt: number;
  headSha: string;
  stages: readonly StageResult[];
  acResults: readonly AcResult[];
  logRef?: string | null;
  reportDigest?: string | null;
  /** 実 CI の補足（記録はせず、止めるときの理由に載せる）。 */
  diagnostics?: { runConclusion: string | null; unmatchedJobs: readonly string[]; acArtifact?: string };
  now: Date;
  correlationId: string;
}

export interface RecordVerificationResult {
  /** recorded: 新規。duplicate: delivery_id か run の重複で無視。 */
  status: 'recorded' | 'duplicate';
  verdict: VerificationVerdict;
  jobState: JobState;
  /** job の状態を動かしたか。cancel 後・停止中・古い SHA の結果は記録だけして動かさない。 */
  advanced: boolean;
}

/** 書き込みの権利。fencing の3条件を必ず where に入れる。 */
export interface JobLease {
  jobId: string;
  owner: string;
  fencingToken: number;
  expectedState: JobState;
}

/** 遅れた書き込みは例外にせず、結果で返して event に残す。 */
export type FencedWrite<T> = { applied: true; value: T } | { applied: false; reason: 'stale_lease' };

/* ────────────────────────────── PR 候補（仕様 4-8・6-4／AGENTS.md） ────────────────────────────── */

/** 判断材料10項目。欠けた項目のある PR は承認の対象にしない。 */
export const PR_DECISION_ITEMS = [
  '要望との対応',
  '変更範囲',
  '受入条件の検証',
  '自動検査',
  '業務確認',
  'モデル現場の結果',
  '原本の保護',
  '運用への影響',
  '復旧方法',
  '残存リスク',
] as const;

/** AGENTS.md の PR 本文の見出し。 */
export const PR_AGENTS_HEADINGS = [
  '目的',
  'MVP範囲',
  '変更',
  'UI影響',
  'API影響',
  'DB影響',
  'Security影響',
  'テスト結果',
  'CI結果',
  'Deployment結果',
  '既知の制限',
  'Rollback',
] as const;
