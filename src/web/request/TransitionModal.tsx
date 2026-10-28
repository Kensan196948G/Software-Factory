import { useMemo, useState } from 'react';
import { api, errorMessage } from '../api.js';
import { Modal } from '../components/ui.js';
import {
  DATA_HANDLING,
  NEXT_BY,
  SIGNAL_LABEL,
  SIGNAL_RANK,
  STATUS_LABEL,
  TAILORING,
  preApprovalChecklist,
  type Signal,
  type Status,
  type Tailoring,
} from '@shared/domain.js';
import type { RequestDetail } from '@shared/types.js';

const REASON_TEMPLATES: Record<string, string[]> = {
  back: [
    '合格の条件を、数字や「〜できる／〜できない」で書き直してください。',
    '「今回は作らない」を書き足してください。',
    '「決める」仕事（合否・金額・安全など）はAIに任せられません。範囲を「材料集め・表示」までに変えてください。',
    '扱う情報（個人情報・お金など）と、見られる人の範囲を書き足してください。',
    '困っていること・目的を、もう少し具体的に（だれが・いつ・どれくらい）書いてください。',
  ],
  hold: [
    '今期は優先度が低いため見送ります（次の見直しで再検討します）。',
    'いまある道具・市販の製品で対応できるため見送ります。',
    '似た依頼にまとめました（受付番号：　）。',
    '元になるデータがそろっていないため見送ります。',
    '依頼者から取り下げの申し出がありました。',
  ],
};

export function TransitionModal({
  detail,
  initialTo,
  onClose,
  onDone,
}: {
  detail: RequestDetail;
  initialTo?: Status;
  onClose: () => void;
  onDone: (detail: RequestDetail, message: string) => void;
}): React.ReactElement {
  const allowed = detail.transitions.filter((t) => t.allowed);
  const defaultTo =
    initialTo && allowed.some((t) => t.to === initialTo)
      ? initialTo
      : allowed.find((t) => t.to === nextOf(detail.status))?.to ?? allowed[0]?.to;
  const [to, setTo] = useState<Status | undefined>(defaultTo);
  const [reason, setReason] = useState('');
  const [signal, setSignal] = useState<Signal | undefined>(detail.signalDecided ?? undefined);
  const [tailoring, setTailoring] = useState<Tailoring | ''>(detail.tailoring ?? '');
  const [checklistAck, setChecklistAck] = useState(false);
  const [redAck, setRedAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = allowed.find((t) => t.to === to);
  const isApproval = to === 'approved';

  const checklist = useMemo(
    () =>
      preApprovalChecklist({
        criteria: detail.criteria,
        outOfScope: detail.outOfScope,
        dataHandling: detail.dataHandling,
        parties: detail.parties,
        approvals: detail.approvals,
        decides: detail.decides,
        suggested: detail.suggested.color,
      }),
    [detail],
  );
  const warns = checklist.filter((i) => i.visible && i.status === 'warn');
  const lowerSignal = signal ? SIGNAL_RANK[signal] < SIGNAL_RANK[detail.suggested.color] : false;
  const reasonRequired = Boolean(selected?.requiresReason) || (isApproval && lowerSignal);

  const submit = async () => {
    if (!to) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ detail: RequestDetail; warnings?: { code: string; message: string }[] }>(
        `/api/requests/${detail.id}/transitions`,
        {
          to,
          version: detail.version,
          reason,
          ...(isApproval ? { signal, tailoring: tailoring || undefined, checklistAcknowledged: checklistAck, redAcknowledged: redAck } : {}),
        },
      );
      onDone(res.detail, `${detail.id} を「${STATUS_LABEL[to]}」に変更しました`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="状態を変更する"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            閉じる
          </button>
          <button type="button" className="btn primary" disabled={!to || busy} onClick={() => void submit()}>
            {busy ? '変更中…' : '変更する'}
          </button>
        </>
      }
    >
      <div className="hint">
        {detail.id}　いま：{STATUS_LABEL[detail.status]}（{detail.staleDays}日目）　操作する人：{detail.applicant}
      </div>

      {error ? (
        <div className="banner err" role="alert">
          {error}
        </div>
      ) : null}

      {allowed.length === 0 ? (
        <div className="banner warn">
          いまの役割では、この依頼の状態は変えられません。次に動かすのは{roleLabel(NEXT_BY[detail.status])}です。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} role="radiogroup" aria-label="変更先の状態">
          {allowed
            .filter((t) => t.to !== 'cancel')
            .map((t) => (
              <label key={t.to} className={`radio ${to === t.to ? 'on' : ''}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', cursor: 'pointer' }}>
                <input type="radio" name="to" value={t.to} checked={to === t.to} onChange={() => setTo(t.to)} />
                <span>
                  <b>{STATUS_LABEL[t.to]}</b>
                  {t.to === nextOf(detail.status) ? <span className="pill brand plain" style={{ marginLeft: 6 }}>次の段階</span> : null}
                  {t.requiresReason ? <span className="hint">（理由必須）</span> : null}
                </span>
              </label>
            ))}
        </div>
      )}

      {isApproval ? (
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <b style={{ fontSize: 12 }}>承認前チェック</b>
            <span className={`pill ${warns.length ? 'y' : 'ok'}`}>△ {warns.length}件</span>
          </div>
          {warns.length === 0 ? (
            <div className="hint">見落としやすい点はありません。</div>
          ) : (
            warns.map((w) => (
              <div key={w.key} className="banner warn" style={{ fontSize: 11.5 }}>
                △ {w.message}
              </div>
            ))
          )}

          <label style={{ fontSize: 11.5, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={checklistAck} onChange={(e) => setChecklistAck(e.target.checked)} />
            上の △ {warns.length} 件を確認しました
          </label>

          <div>
            <div className="hint" style={{ marginBottom: 4 }}>
              信号の色（候補：{SIGNAL_LABEL[detail.suggested.color]}）
            </div>
            <div style={{ display: 'flex', gap: 6 }} role="radiogroup" aria-label="信号の色">
              {(['g', 'y', 'r'] as Signal[]).map((s) => (
                <label key={s} className={`check-chip ${signal === s ? 'on' : ''}`}>
                  <input type="radio" name="signal" value={s} checked={signal === s} onChange={() => setSignal(s)} />
                  {SIGNAL_LABEL[s]}
                  {detail.suggested.color === s ? '（候補）' : ''}
                </label>
              ))}
            </div>
            <ul className="hint" style={{ margin: '6px 0 0 16px' }}>
              {detail.suggested.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>

          {signal === 'r' ? (
            <label style={{ fontSize: 11.5, display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={redAck} onChange={(e) => setRedAck(e.target.checked)} />
              AIに決めさせません（材料集め・表示まで）を確認しました
            </label>
          ) : null}

          {lowerSignal ? (
            <div className="banner warn" style={{ fontSize: 11.5 }}>候補よりゆるい色にする場合は、理由をメモに書いてください。</div>
          ) : null}

          <div className="field">
            <label htmlFor="tailoring">型（任意）</label>
            <select id="tailoring" className="select" value={tailoring} onChange={(e) => setTailoring(e.target.value as Tailoring | '')}>
              <option value="">未設定</option>
              {TAILORING.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {to === 'cancel' ? (
        <div className="banner warn" style={{ fontSize: 11.5 }}>
          取消にしてもデータは残ります（一覧の「取消を表示」で確認できます）。
        </div>
      ) : null}

      {to && to !== 'approved' ? (
        <div className="field">
          <label htmlFor="reason">
            メモ{reasonRequired ? '（必須）' : '（任意）'}
          </label>
          <textarea id="reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonRequired ? '理由を書いてください' : '補足があれば書いてください'} />
          {to === 'back' || to === 'hold' ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {(REASON_TEMPLATES[to] ?? []).map((tpl) => (
                <button
                  key={tpl}
                  type="button"
                  className="btn sm"
                  onClick={() => setReason((prev) => (prev.trim() === '' ? tpl : prev.includes(tpl) ? prev : `${prev}\n${tpl}`))}
                >
                  {tpl.length > 22 ? `${tpl.slice(0, 22)}…` : tpl}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {isApproval ? (
        <div className="field">
          <label htmlFor="reason-approval">メモ{lowerSignal ? '（必須）' : '（任意）'}</label>
          <textarea id="reason-approval" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={lowerSignal ? '候補よりゆるい色にする理由' : '補足があれば書いてください'} />
        </div>
      ) : null}

      {detail.dataHandling.length > 0 ? (
        <div className="hint">
          扱う情報：{detail.dataHandling.map((k) => DATA_HANDLING.find((d) => d.key === k)?.label ?? k).join('、')}
        </div>
      ) : null}
    </Modal>
  );
}

function nextOf(status: Status): Status | undefined {
  const map: Partial<Record<Status, Status>> = {
    received: 'review',
    review: 'wait',
    wait: 'approved',
    approved: 'dev',
    dev: 'verify',
    verify: 'field',
    field: 'release_wait',
    release_wait: 'done',
    back: 'received',
  };
  return map[status];
}

function roleLabel(role: string | undefined): string {
  return role === 'approver' ? '承認者' : role === 'desk' ? '受付担当' : '依頼者';
}

