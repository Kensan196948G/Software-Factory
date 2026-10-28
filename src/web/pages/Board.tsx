import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api.js';
import { useAuth } from '../auth.js';
import { Banner, EmptyState, SignalPill, Skeleton, StaleBadge } from '../components/ui.js';
import { MAIN_FLOW, STATUS_LABEL, type Status } from '@shared/domain.js';
import type { ListResponse, RequestSummary } from '@shared/types.js';

const OTHER: Status[] = ['back', 'hold', 'cancel'];

export function Board(): React.ReactElement {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [items, setItems] = useState<RequestSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [dept, setDept] = useState('');

  useEffect(() => {
    setItems(null);
    api
      .get<ListResponse>(`/api/requests?pageSize=500${dept ? `&dept=${dept}` : ''}`)
      .then((r) => setItems(r.items))
      .catch((err) => setError(errorMessage(err)));
  }, [dept]);

  const grouped = useMemo(() => {
    const map = new Map<Status, RequestSummary[]>();
    for (const s of [...MAIN_FLOW, ...OTHER]) map.set(s, []);
    for (const item of items ?? []) {
      if (onlyMine && !item.yourTurn.target) continue;
      if (!map.has(item.status)) map.set(item.status, []);
      map.get(item.status)?.push(item);
    }
    return map;
  }, [items, onlyMine]);

  if (error) return <Banner kind="err" action={<button className="btn sm" onClick={() => setDept(dept)}>再試行</button>}>{error}</Banner>;
  if (!items) return <Skeleton lines={6} />;

  const open = (id: string) => navigate(`/board?request=${id}`);

  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="btn sm" style={{ gap: 6 }}>
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
          あなたの番だけ
        </label>
        <select className="select" style={{ width: 200 }} value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">全部署</option>
          {Array.from(new Set(items.map((i) => i.deptCode))).map((code) => (
            <option key={code} value={code}>{items.find((i) => i.deptCode === code)?.deptName ?? code}</option>
          ))}
        </select>
        <span className="hint" style={{ marginLeft: 'auto' }}>
          {user ? `${items.length} 件（表示：${onlyMine ? 'あなたの番のみ' : 'すべて'}）` : `${items.length} 件`}
        </span>
      </div>

      <div className="board">
        {[...MAIN_FLOW, ...OTHER].map((status) => {
          const list = grouped.get(status) ?? [];
          return (
            <section key={status} className={`col ${OTHER.includes(status) ? 'other' : ''}`} aria-label={STATUS_LABEL[status]}>
              <div className="col-head">
                <span>{STATUS_LABEL[status]}</span>
                <span className="n">{list.length}</span>
              </div>
              {list.length === 0 ? (
                <div className="empty-col">ここには今はありません</div>
              ) : (
                list.map((r) => (
                  <article key={r.id} className={`card-mini ${r.staleLevel === 'ok' ? '' : r.staleLevel}`}>
                    <div className="meta">
                      <SignalPill signal={r.suggested} />
                      <span className="mono">{r.id.slice(-4)}</span>
                      {r.staleDays > 0 ? <StaleBadge days={r.staleDays} level={r.staleLevel} /> : null}
                    </div>
                    <b>{r.title}</b>
                    <div className="meta">{r.deptName} · {r.applicant}</div>
                    <button type="button" className="btn sm" style={{ width: '100%', marginTop: 6 }} onClick={() => open(r.id)} aria-label={`${r.id} の詳細を開く`}>
                      詳細を開く
                    </button>
                  </article>
                ))
              )}
            </section>
          );
        })}
      </div>
      {items.length === 0 ? <EmptyState title="まだ依頼がありません" icon="◫" action={<button className="btn primary" onClick={() => navigate('/new')}>新しい依頼</button>} /> : null}
    </>
  );
}
