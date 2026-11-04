/**
 * 依頼ごとの開発ラインの投入先リポジトリ（L-12）。
 *
 * 正本は**サーバ**。画面（`src/web/public/console.js`）が送る値はそのまま使わず、ここで
 * 設定（`DEVLINE_TARGET_REPOS`）と許可台帳（`DEVLINE_REPO_LEDGER`）の**積集合**に載っている
 * 名前（`owner/name`）だけを受け付ける。積集合の外は ERR-405 で拒否する（新しいコードは作らない）。
 *
 * - 未指定（null / 空）は「既定」＝積集合の先頭。既存の依頼は `request.target_repo_id` が NULL で、
 *   投入のときに従来どおり `DevlineDeps.targetRepo`（設定の先頭）を使う（後方互換）。
 * - 作成・更新の API は `requestInputSchema.targetRepoId` を受ける（`readTargetRepoInput`）。
 * - 画面の選択は `PATCH /api/requests/:id/devline-target`（`setRequestTargetRepo`）で保存する。
 *   依頼の内容（注文書）ではないので版（`order_version`）と承認を動かさない。
 */
import { config } from './config.js';
import { appendAuditTx } from './audit.js';
import { withTransaction } from './db.js';
import { ApiError, Errors } from './http.js';
import { getRequestRowForUpdate } from './repo.js';
import type { DevlineDeps } from './devline-handoff.js';
import type { Actor } from './service.js';
import { allowedLedgerRepos, canHandoff, findTargetRepoInLedger, type RepoAllowEntry } from '../shared/devline.js';

/** 画面に見せる候補1件。秘密は無い（台帳の用途まで）。 */
export interface TargetRepoChoice {
  name: string;
  repoId: string;
  purpose: string;
  /** 未指定のときに使う既定（積集合の先頭）。 */
  isDefault: boolean;
}

/** 許可された投入先（設定と台帳の積集合）。順は設定の順で、先頭が既定。 */
export function allowedTargetRepos(deps?: DevlineDeps): RepoAllowEntry[] {
  return allowedLedgerRepos(deps?.allowedRepos ?? config.devlineTargetRepos, deps?.ledger);
}

/** 画面の候補。積集合が空なら items は空で defaultRepo は null（投入は全て ERR-405）。 */
export function listTargetRepos(deps?: DevlineDeps): { items: TargetRepoChoice[]; defaultRepo: string | null } {
  const allowed = allowedTargetRepos(deps);
  const items = allowed.map((r, i) => ({ name: r.name, repoId: r.repoId, purpose: r.purpose, isDefault: i === 0 }));
  return { items, defaultRepo: items[0]?.name ?? null };
}

/** 依頼に保存してよい投入先か（積集合の完全一致だけ）。外れていれば ERR-405。 */
export function requireTargetRepo(name: string, deps?: DevlineDeps): RepoAllowEntry {
  const entry = findTargetRepoInLedger(name, deps?.allowedRepos ?? config.devlineTargetRepos, deps?.ledger);
  if (!entry) {
    throw new ApiError('ERR-405', '投入先のリポジトリが許可されていません（DEVLINE_TARGET_REPOS と許可台帳の積集合）', 409, {
      targetRepoId: name,
    });
  }
  return entry;
}

export interface TargetRepoInput {
  /** 本文に `targetRepoId` があったか。無ければ更新では現状維持、作成では未指定（NULL）。 */
  provided: boolean;
  /** 保存する値。null は「未指定（既定）」に戻す。 */
  value: string | null;
}

/**
 * 作成・更新の本文から投入先を取り出す。`targetRepoId` が無いときは `provided: false`（現状維持）。
 * null / 空文字は「未指定へ戻す」。文字列は積集合の完全一致だけを受理する（`requireTargetRepo`）。
 */
export function readTargetRepoInput(body: unknown, deps?: DevlineDeps): TargetRepoInput {
  if (typeof body !== 'object' || body === null || !Object.hasOwn(body, 'targetRepoId')) {
    return { provided: false, value: null };
  }
  const raw = (body as { targetRepoId?: unknown }).targetRepoId;
  if (raw === undefined || raw === null) return { provided: true, value: null };
  const name = String(raw).trim();
  if (name === '') return { provided: true, value: null };
  return { provided: true, value: requireTargetRepo(name, deps).name };
}

export interface SetTargetRepoResult {
  requestId: string;
  targetRepoId: string | null;
  /** 未指定のときに使う既定（積集合の先頭）。画面が「既定に戻す」を出すため。 */
  defaultRepo: string | null;
  changed: boolean;
}

/**
 * 依頼の投入先を変える（画面の選択）。内容の編集ではないので `order_version` と承認を動かさない。
 * 監査に `request.update`（from / to）を残す。拒否も監査に残してから投げる（既存の流儀）。
 */
export async function setRequestTargetRepo(
  input: { requestId: string; targetRepoId: string | null },
  actor: Actor,
  correlationId: string,
  deps?: DevlineDeps,
): Promise<SetTargetRepoResult> {
  const facts = { role: actor.role, isAdmin: actor.user.isAdmin };
  const denial: { error?: ApiError } = {};
  const outcome = await withTransaction(async (client) => {
    const row = await getRequestRowForUpdate(client, input.requestId);
    if (!row) throw Errors.notFound('依頼');
    const deny = async (error: ApiError, why: string, diff: Record<string, unknown> = {}): Promise<null> => {
      await appendAuditTx(client, {
        action: 'request.update',
        targetType: 'request',
        targetId: input.requestId,
        result: 'denied',
        actorUserId: actor.userId,
        actorName: actor.displayName,
        role: actor.role,
        correlationId,
        diff: { field: 'targetRepoId', why, ...diff },
      });
      denial.error = error;
      return null;
    };
    if (!canHandoff(facts)) return deny(Errors.noPermission(), 'role');
    if (row.deleted) return deny(Errors.notFound('依頼'), 'deleted');
    if (['done', 'hold', 'cancel'].includes(row.status)) {
      return deny(Errors.invalidTransition('終了・保留・取消の依頼は投入先を変えられません'), 'status', { status: row.status });
    }
    // 送信中の投入があると、対象を変えると結果の照合先が分からなくなる
    const inflight = await client.query<{ state: string }>(
      `select state from handoff_intent where request_id=$1 and state in ('intent','sent','unknown') limit 1`,
      [input.requestId],
    );
    if (inflight.rows[0]) {
      return deny(
        new ApiError('ERR-301', '投入の結果が確定していないため、投入先を変えられません（先に照合してください）', 409, {
          handoffState: inflight.rows[0].state,
        }),
        'in_flight',
        { handoffState: inflight.rows[0].state },
      );
    }
    const succeeded = await client.query<{ target_repo_id: string }>(
      `select target_repo_id from handoff_intent where request_id=$1 and state='succeeded'`,
      [input.requestId],
    );
    const value = input.targetRepoId === null ? null : requireTargetRepo(input.targetRepoId, deps).name;
    // 投入済みの repo と食い違う変更は断る。比較は**実効値**（次に投入する repo）で行う:
    // 未指定（null）は既定＝積集合の先頭に解決されるので、null へ戻す変更も同じ検査を通す。
    // 例: B へ投入済みの依頼で null に戻すと次は既定の A へ行こうとする → ERR-405。
    const effective = value ?? allowedTargetRepos(deps)[0]?.name ?? null;
    // request.issue_no は別のリポジトリの番号かもしれない。別の repo に投入済みなら対象を変えさせない
    // （変えても投入のときに ERR-405 になる。ここで理由を返す）。
    if (effective !== null && succeeded.rows.length > 0 && succeeded.rows.every((r) => r.target_repo_id !== effective)) {
      return deny(
        new ApiError('ERR-405', 'この依頼はすでに別のリポジトリへ投入されているため、投入先を変えられません', 409, {
          targetRepo: succeeded.rows[0]?.target_repo_id ?? null,
          effectiveTargetRepo: effective,
        }),
        'already_handed_off',
        { targetRepo: succeeded.rows[0]?.target_repo_id ?? null, effectiveTargetRepo: effective },
      );
    }
    if ((row.target_repo_id ?? null) === value) return { value, changed: false };
    await client.query('update request set target_repo_id=$2, updated_at=now(), updated_by=$3 where id=$1', [
      input.requestId,
      value,
      actor.userId,
    ]);
    await appendAuditTx(client, {
      action: 'request.update',
      targetType: 'request',
      targetId: input.requestId,
      result: 'success',
      actorUserId: actor.userId,
      actorName: actor.displayName,
      role: actor.role,
      correlationId,
      diff: { field: 'targetRepoId', from: row.target_repo_id, to: value },
    });
    return { value, changed: true };
  });
  if (denial.error) throw denial.error;
  const saved = outcome as { value: string | null; changed: boolean };
  return {
    requestId: input.requestId,
    targetRepoId: saved.value,
    defaultRepo: listTargetRepos(deps).defaultRepo,
    changed: saved.changed,
  };
}
