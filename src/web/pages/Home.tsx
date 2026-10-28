import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api.js';
import { useAuth } from '../auth.js';
import { Banner, EmptyState, SignalPill, Skeleton, StaleBadge, StatusPill, useToast } from '../components/ui.js';
import { NEXT_STATUS, ROLE_LABEL, STATUS_LABEL, type Status } from '@shared/domain.js';
import type { HistoryEntry, HomeResponse, RequestSummary } from '@shared/types.js';

export function Home(): React.ReactElement {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<HomeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      setData(await api.get<HomeResponse>('/api/home'));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    void load();
  }, [user?.actingRole]);

  const open = (id: string, action?: 'next') => {
    navigate(`/?request=${id}${action ? '&do=next' : ''}`);
  };

  if (!data) {
    return error ? <Banner kind="err" action={<button className="btn sm" onClick={() => void load()}>再試行</button>}>{error}</Banner> : <Skeleton lines={6} />;
  }

  const greeting = `おはようございます、${user?.displayName ?? ''}さん`;

  return (
    <>
      <div className="banner info">
        <div className="grow">
          <b>{greeting}</b>
          <div>
            あなたの番が <b>{data.counts.yourTurn}</b> 件、3日以上止まっている依頼が <b>{data.counts.stale3}</b> 件あります。
            {data.counts.draft ? ' 書きかけの依頼があります。' : ''}
          </div>
        </div>
        <button type="button" className="btn sm primary" onClick={() => navigate('/new')}>
          ＋ 新しい依頼
        </button>
      </div>

      {error ? <Banner kind="err">{error}</Banner> : null}

      <div className="grid-3">
        <div className="stat">
          <div className="k">あなたの番</div>
          <div className="v">
            {data.counts.yourTurn}
            <small>件</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">承認待ち（自分が承認者）</div>
          <div className="v">
            {data.counts.waitingApproval}
            <small>件</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">3日以上止まっている</div>
          <div className="v">
            {data.counts.stale3}
            <small>件</small>
          </div>
        </div>
      </div>

      <section className="card" aria-label="あなたの番">
        <div className="card-head">
          <h3>あなたの番</h3>
          <span className="count">{data.counts.yourTurn} 件</span>
          <span className="hint">（{ROLE_LABEL[data.role]}として、次に動かす依頼です・止まっている日数の長い順）</span>
        </div>
        {data.yourTurn.length === 0 ? (
          <EmptyState title="いまはありません" icon="✓">
            ほかの人の番の依頼は、ボードと一覧で見られます。
          </EmptyState>
        ) : (
          <div className="list-tight">
            {data.yourTurn.map((r) => (
              <YourTurnRow
                key={r.id}
                request={r}
                busy={busy === r.id}
                onOpen={() => open(r.id)}
                onNext={async () => {
                  setBusy(r.id);
                  try {
                    const next = NEXT_STATUS[r.status];
                    if (!next) return;
                    await api.post(`/api/requests/${r.id}/transitions`, { to: next, version: r.version });
                    toast.push(`${r.id} を「${STATUS_LABEL[next]}」に進めました`, {
                      undo: async () => {
                        await api.post(`/api/requests/${r.id}/transitions`, { to: r.status, version: r.version + 1, reason: '元に戻す' }).catch(() => undefined);
                        await load();
                      },
                    });
                    await load();
                  } catch (err) {
                    toast.push(errorMessage(err), { kind: 'err' });
                  } finally {
                    setBusy(null);
                  }
                }}
                onSpecial={() => open(r.id, 'next')}
              />
            ))}
          </div>
        )}
      </section>

      <div className="grid-2">
        <section className="card" aria-label="止まっている依頼">
          <div className="card-head">
            <h3>止まっている依頼（3日以上・ほかの人の番）</h3>
            <span className="count">{data.staleOthers.length}</span>
          </div>
          {data.staleOthers.length === 0 ? (
            <EmptyState title="止まっている依頼はありません" icon="✓" />
          ) : (
            data.staleOthers.map((r) => (
              <button key={r.id} type="button" className={`row ${r.staleLevel}`} onClick={() => open(r.id)}>
                <span className="id">{r.id}</span>
                <SignalPill signal={r.suggested} />
                <StatusPill status={r.status} />
                <StaleBadge days={r.staleDays} level={r.staleLevel} />
                <span className="title">{r.title}</span>
                <span className="sp hint">次は{nextLabel(r.status)}</span>
              </button>
            ))
          )}
        </section>

        <section className="card" aria-label="あなたの依頼">
          <div className="card-head">
            <h3>{data.role === 'requester' ? 'あなたの依頼' : 'あなたの依頼（ほかの人の番）'}</h3>
            <span className="count">{data.myRequests.length}</span>
          </div>
          {data.myRequests.length === 0 ? (
            <EmptyState title="いまはありません" icon="◫" />
          ) : (
            data.myRequests.map((r) => (
              <button key={r.id} type="button" className="row" onClick={() => open(r.id)}>
                <span className="id">{r.id}</span>
                <SignalPill signal={r.suggested} />
                <StatusPill status={r.status} />
                <span className="title">{r.title}</span>
                <span className="sp hint">次は{nextLabel(r.status)}</span>
              </button>
            ))
          )}
        </section>
      </div>

      <section className="card" aria-label="最近の動き">
        <div className="card-head">
          <h3>最近の動き</h3>
        </div>
        {data.recent.length === 0 ? (
          <EmptyState title="まだ動きがありません" icon="◷" />
        ) : (
          data.recent.map((h: HistoryEntry) => (
            <div key={h.id} className="row" style={{ cursor: 'default' }}>
              <span className="id">{new Date(h.at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              <span style={{ fontSize: 12 }}>
                {h.actorName} が {h.action}
                {h.note ? `（${h.note}）` : ''}
              </span>
            </div>
          ))
        )}
      </section>
    </>
  );
}

function YourTurnRow({
  request,
  busy,
  onOpen,
  onNext,
  onSpecial,
}: {
  request: RequestSummary;
  busy: boolean;
  onOpen: () => void;
  onNext: () => Promise<void>;
  onSpecial: () => void;
}): React.ReactElement {
  const next = NEXT_STATUS[request.status];
  const needsModal = next === 'approved' || next === 'done' || !next;
  return (
    <div className={`row ${request.staleLevel}`}>
      <button type="button" className="btn ghost" style={{ all: 'unset', display: 'contents', cursor: 'pointer' }} onClick={onOpen} aria-label={`${request.id} の詳細を開く`}>
        <span className="id">{request.id}</span>
        <SignalPill signal={request.suggested} />
        <StatusPill status={request.status} />
        <StaleBadge days={request.staleDays} level={request.staleLevel} />
        <span className="title">{request.title}</span>
      </button>
      <span className="sp">
        <span className="hint" style={{ fontSize: 10.5 }}>{request.yourTurn.action}</span>
        {next ? (
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => void (needsModal ? onSpecial() : onNext())}
          >
            {busy ? '…' : `→ ${STATUS_LABEL[next]}へ`}
          </button>
        ) : null}
      </span>
    </div>
  );
}

function nextLabel(status: Status): string {
  const map: Partial<Record<Status, string>> = {
    received: '受付担当',
    review: '受付担当',
    wait: '承認者',
    approved: '受付担当',
    dev: '受付担当',
    verify: '受付担当',
    field: '受付担当',
    release_wait: '承認者',
    back: '依頼者',
    done: '－',
    hold: '－',
    cancel: '－',
  };
  return map[status] ?? '－';
}
