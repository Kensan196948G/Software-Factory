import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api.js';
import { Banner, Drawer, ProgressBand, SignalPill, Skeleton, StaleBadge, StatusPill, useToast } from '../components/ui.js';
import { TransitionModal } from './TransitionModal.js';
import {
  DATA_HANDLING,
  KIND_LABEL,
  NEXT_BY,
  NEXT_STATUS,
  PARTY_LABEL,
  ROLE_LABEL,
  STATUS_LABEL,
  type Status,
} from '@shared/domain.js';
import type { RequestDetail } from '@shared/types.js';

type Tab = 'summary' | 'order' | 'history';

export function DetailDrawer({
  id,
  initialDo,
  onClose,
}: {
  id: string;
  initialDo?: string | null;
  onClose: () => void;
}): React.ReactElement {
  const navigate = useNavigate();
  const toast = useToast();
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('summary');
  const [transitionOpen, setTransitionOpen] = useState(false);
  const [initialTo, setInitialTo] = useState<Status | undefined>();
  const [order, setOrder] = useState<string | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await api.get<{ request: RequestDetail }>(`/api/requests/${id}`);
      setDetail(res.request);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    void load();
    // id が変わったときだけ再取得する（load は毎レンダーで作り直されるため）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (initialDo === 'next' && detail) {
      const next = NEXT_STATUS[detail.status];
      if (next) {
        setInitialTo(next);
        setTransitionOpen(true);
      }
    }
    // detail 全体ではなく id の変化だけを見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDo, detail?.id]);

  useEffect(() => {
    if (tab !== 'order' || order || !detail) return;
    api
      .get<{ yaml: string }>(`/api/requests/${id}/order`)
      .then((r) => setOrder(r.yaml))
      .catch((err) => setOrderError(errorMessage(err)));
  }, [tab, order, detail, id]);

  const doNext = async () => {
    if (!detail) return;
    const next = NEXT_STATUS[detail.status];
    if (!next) return;
    if (next === 'approved' || next === 'done') {
      setInitialTo(next);
      setTransitionOpen(true);
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ detail: RequestDetail }>(`/api/requests/${id}/transitions`, { to: next, version: detail.version });
      setDetail(res.detail);
      toast.push(`${id} を「${STATUS_LABEL[next]}」に進めました`);
    } catch (err) {
      toast.push(errorMessage(err), { kind: 'err' });
    } finally {
      setBusy(false);
    }
  };

  const addComment = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      const res = await api.post<{ detail: RequestDetail }>(`/api/requests/${id}/comments`, { text: comment.trim() });
      setDetail(res.detail);
      setComment('');
      toast.push('コメントを追加しました');
    } catch (err) {
      toast.push(errorMessage(err), { kind: 'err' });
    } finally {
      setBusy(false);
    }
  };

  const handoff = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ issueNo: number; issueUrl: string; created: boolean; detail: RequestDetail }>(`/api/requests/${id}/handoff`);
      setDetail(res.detail);
      toast.push(res.created ? `GitHub Issue #${res.issueNo} を作成しました` : `GitHub Issue #${res.issueNo} は作成済みです`);
    } catch (err) {
      toast.push(errorMessage(err), { kind: 'err' });
    } finally {
      setBusy(false);
    }
  };

  const canNext = detail ? detail.transitions.some((t) => t.allowed && t.to === NEXT_STATUS[detail.status]) : false;

  return (
    <Drawer title={`${id} の詳細`} onClose={onClose}>
      {!detail ? (
        error ? (
          <Banner kind="err" action={<button className="btn sm" onClick={() => void load()}>再試行</button>}>{error}</Banner>
        ) : (
          <Skeleton lines={8} />
        )
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <div>
              <div className="mono hint">
                {detail.id} · {detail.deptName}
              </div>
              <h2 style={{ fontSize: 18 }}>{detail.title}</h2>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              <SignalPill signal={detail.signalDecided ?? detail.suggested.color} />
              <StatusPill status={detail.status} />
              <button type="button" className="btn ghost sm" onClick={onClose} aria-label="閉じる">✕</button>
            </div>
          </div>

          <ProgressBand status={detail.status} />
          <div className="kpi-inline">
            <span>滞留 <b>{detail.staleDays}</b> 日</span>
            <span>削減見込み <b>{detail.measure.toFixed(1)}</b> h/月</span>
            <span>版 <b>{detail.version}</b></span>
            {detail.issueNo ? <span>Issue <b>#{detail.issueNo}</b></span> : null}
            <StaleBadge days={detail.staleDays} level={detail.staleLevel} />
          </div>

          <div className="banner info">
            <div className="grow">
              {detail.yourTurn.target ? (
                <>
                  <b>あなたの番です</b>
                  <div>{detail.yourTurn.action}</div>
                </>
              ) : (
                <>
                  <b>次に動かすのは {roleLabel(NEXT_BY[detail.status])} です</b>
                  <div>いまの状態になってから {detail.staleDays} 日</div>
                </>
              )}
            </div>
            {detail.yourTurn.target && canNext ? (
              <button type="button" className="btn sm primary" disabled={busy} onClick={() => void doNext()}>
                → {STATUS_LABEL[NEXT_STATUS[detail.status] as Status]}へ
              </button>
            ) : null}
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn sm" onClick={() => { setInitialTo(undefined); setTransitionOpen(true); }}>
              状態を変更
            </button>
            <button type="button" className="btn sm" onClick={() => navigate(`/new?edit=${detail.id}`)}>
              編集
            </button>
            {detail.signalDecided && ['approved', 'dev', 'verify', 'field', 'release_wait', 'done'].includes(detail.status) ? (
              <button type="button" className="btn sm" disabled={busy || Boolean(detail.issueNo)} onClick={() => void handoff()}>
                {detail.issueNo ? `Issue #${detail.issueNo} 作成済み` : 'GitHub Issueを作成'}
              </button>
            ) : null}
          </div>

          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'summary'} className={`tab ${tab === 'summary' ? 'on' : ''}`} onClick={() => setTab('summary')}>概要</button>
            <button type="button" role="tab" aria-selected={tab === 'order'} className={`tab ${tab === 'order' ? 'on' : ''}`} onClick={() => setTab('order')}>注文書（YAML）</button>
            <button type="button" role="tab" aria-selected={tab === 'history'} className={`tab ${tab === 'history' ? 'on' : ''}`} onClick={() => setTab('history')}>
              コメント・履歴 {(detail.comments?.length ?? 0) + (detail.history?.length ?? 0)}
            </button>
          </div>

          {tab === 'summary' ? (
            <>
              <dl className="dl">
                <dt>起票者</dt><dd>{detail.applicant}</dd>
                <dt>承認者</dt><dd>{detail.approver}</dd>
                <dt>依頼区分</dt><dd>{KIND_LABEL[detail.kind]}</dd>
                <dt>道具</dt><dd>{detail.toolName ?? 'カタログ外'}</dd>
                <dt>だれが使う</dt><dd>{detail.users.join('・')}</dd>
                <dt>どこで使う</dt><dd>{detail.places.join('・') || '未設定'}</dd>
                <dt>関わる相手</dt><dd>{PARTY_LABEL[detail.parties]}</dd>
                <dt>信号の候補</dt><dd><SignalPill signal={detail.suggested.color} /> {detail.suggested.reasons.join(' / ')}</dd>
                <dt>扱う情報</dt><dd>{detail.dataHandling.length ? detail.dataHandling.map((k) => DATA_HANDLING.find((d) => d.key === k)?.label ?? k).join('、') : '特別な情報は扱いません'}</dd>
                <dt>今回は作らない</dt><dd>{detail.outOfScope.join('、') || '未設定'}</dd>
              </dl>

              <div>
                <b style={{ fontSize: 12 }}>困っていること</b>
                <p style={{ fontSize: 12.5 }}>{detail.problem}</p>
                <b style={{ fontSize: 12 }}>目的</b>
                <p style={{ fontSize: 12.5 }}>{detail.purpose}</p>
                <b style={{ fontSize: 12 }}>作るもの</b>
                <ul style={{ fontSize: 12.5, margin: '4px 0', paddingLeft: 18 }}>
                  {detail.scope.map((s) => <li key={s}>{s}</li>)}
                </ul>
              </div>

              <div>
                <b style={{ fontSize: 12 }}>合格の条件</b>
                <div className="list-tight" style={{ marginTop: 4 }}>
                  {detail.criteriaChecks.map((c, i) => (
                    <div key={i} className={`row ${c.kind === 'ok' ? '' : 'warn'}`} style={{ cursor: 'default', fontSize: 12 }}>
                      <span className={`pill ${c.kind === 'ok' ? 'ok' : 'y'} plain`}>{c.kind === 'ok' ? 'OK' : 'あいまい'}</span>
                      <span>{c.text}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="card" style={{ background: 'var(--surface-2)' }}>
                <b style={{ fontSize: 12 }}>ものさし（参考値）</b>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
                  {detail.score.map((s) => (
                    <span key={s.key} className="hint">
                      {s.label}: <b className="mono">{s.score === 0 ? '－' : s.score}</b>
                    </span>
                  ))}
                </div>
                <div className="hint" style={{ marginTop: 4 }}>月あたり削減見込み {detail.measure.toFixed(1)} 時間（上限の目安）。点数だけで着手順は決めません。</div>
              </div>
            </>
          ) : null}

          {tab === 'order' ? (
            orderError ? (
              <Banner kind="warn">{orderError}</Banner>
            ) : order ? (
              <>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn sm" onClick={() => void navigator.clipboard.writeText(order).then(() => toast.push('注文書YAMLをコピーしました'))}>コピー</button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      const blob = new Blob([order], { type: 'text/yaml' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `${detail.id}.yaml`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    ダウンロード
                  </button>
                </div>
                <pre className="pre">{order}</pre>
              </>
            ) : (
              <Skeleton lines={6} />
            )
          ) : null}

          {tab === 'history' ? (
            <>
              <div className="field">
                <label htmlFor="comment">コメント</label>
                <textarea id="comment" className="textarea" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="補足や相談を書けます" />
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="button" className="btn sm primary" disabled={busy || !comment.trim()} onClick={() => void addComment()}>追加</button>
                </div>
              </div>
              <div className="list-tight">
                {(detail.history ?? []).map((h) => (
                  <div key={`h-${h.id}`} className="row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                    <span className="id">{new Date(h.at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    <span style={{ fontSize: 12 }}>
                      <b>{h.actorName}</b>（{h.role === 'system' ? 'システム' : ROLE_LABEL[h.role]}） {h.action}
                      {h.note ? <div className="hint">{h.note}</div> : null}
                    </span>
                  </div>
                ))}
                {(detail.comments ?? []).map((c) => (
                  <div key={`c-${c.id}`} className="row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                    <span className="id">{new Date(c.at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    <span style={{ fontSize: 12 }}>
                      <b>{c.by}</b>
                      <div>{c.text}</div>
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {transitionOpen ? (
            <TransitionModal
              detail={detail}
              initialTo={initialTo}
              onClose={() => setTransitionOpen(false)}
              onDone={(next, message) => {
                setDetail(next);
                setTransitionOpen(false);
                toast.push(message);
              }}
            />
          ) : null}
        </>
      )}
    </Drawer>
  );
}

function roleLabel(role: string | undefined): string {
  if (!role) return '－';
  return role === 'approver' ? '承認者' : role === 'desk' ? '受付担当' : '依頼者';
}

