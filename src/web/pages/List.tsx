import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api.js';
import { Banner, EmptyState, SignalPill, Skeleton, StaleBadge, StatusPill } from '../components/ui.js';
import { SIGNAL_LABEL, STATUSES, STATUS_LABEL, type Status } from '@shared/domain.js';
import type { DepartmentRow, ListResponse, RequestSummary } from '@shared/types.js';

export function List(): React.ReactElement {
  const navigate = useNavigate();
  const [items, setItems] = useState<RequestSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [status, setStatus] = useState('');
  const [signal, setSignal] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [page, setPage] = useState(1);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<{ items: DepartmentRow[] }>('/api/catalog/departments').then((r) => setDepartments(r.items)).catch(() => undefined);
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams({ pageSize: '50', page: String(page) });
      if (q.trim()) params.set('q', q.trim());
      if (dept) params.set('dept', dept);
      if (status) params.set('status', status);
      if (signal) params.set('signal', signal);
      if (includeDeleted) params.set('includeDeleted', '1');
      api
        .get<ListResponse>(`/api/requests?${params.toString()}`)
        .then((r) => {
          setItems(r.items);
          setTotal(r.total);
          setError(null);
        })
        .catch((err) => setError(errorMessage(err)))
        .finally(() => setLoading(false));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [q, dept, status, signal, includeDeleted, page]);

  const pages = useMemo(() => Math.max(1, Math.ceil(total / 50)), [total]);

  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: 1, minWidth: 220 }} placeholder="受付番号・件名・困りごとで検索" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="検索" />
        <select className="select" style={{ width: 170 }} value={dept} onChange={(e) => { setDept(e.target.value); setPage(1); }} aria-label="部署">
          <option value="">全部署</option>
          {departments.map((d) => (
            <option key={d.code} value={d.code}>{d.name}</option>
          ))}
        </select>
        <select className="select" style={{ width: 150 }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="状態">
          <option value="">すべての状態</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </select>
        <select className="select" style={{ width: 120 }} value={signal} onChange={(e) => { setSignal(e.target.value); setPage(1); }} aria-label="信号">
          <option value="">色：すべて</option>
          {(['g', 'y', 'r'] as const).map((s) => (
            <option key={s} value={s}>{SIGNAL_LABEL[s]}</option>
          ))}
        </select>
        <label className="btn sm" style={{ gap: 6 }}>
          <input type="checkbox" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
          取消を表示
        </label>
        <a className="btn sm" href="/api/export.csv">CSV</a>
        <a className="btn sm" href="/api/export.json">JSON</a>
      </div>

      {error ? <Banner kind="err" action={<button className="btn sm" onClick={() => setPage(page)}>再試行</button>}>{error}</Banner> : null}

      {loading && !items ? (
        <Skeleton lines={6} />
      ) : !items || items.length === 0 ? (
        <EmptyState title="条件に合う依頼がありません" icon="⌕">
          絞り込みを解除してください。
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>受付番号</th>
                  <th>件名</th>
                  <th>部署</th>
                  <th>起票者</th>
                  <th>信号</th>
                  <th>状態</th>
                  <th>滞留</th>
                  <th>次は</th>
                  <th style={{ textAlign: 'right' }}>削減見込み</th>
                  <th>更新</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className={r.yourTurn.target ? 'mine' : ''} onClick={() => navigate(`/requests?request=${r.id}`)}>
                    <td className="mono">{r.id}</td>
                    <td className="title-cell" title={r.title}>{r.title}</td>
                    <td>{r.deptName}</td>
                    <td>{r.applicant}</td>
                    <td><SignalPill signal={r.signalDecided ?? r.suggested} /></td>
                    <td><StatusPill status={r.status as Status} /></td>
                    <td>{['done', 'hold', 'cancel'].includes(r.status) ? '－' : <StaleBadge days={r.staleDays} level={r.staleLevel} />}</td>
                    <td>{r.yourTurn.target ? <span className="pill brand plain">あなたの番</span> : nextLabel(r.status as Status)}</td>
                    <td className="num">{r.measure.toFixed(1)}</td>
                    <td className="mono">{new Date(r.updatedAt).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="hint">{total} 件中 {(page - 1) * 50 + 1}–{Math.min(page * 50, total)} 件</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              <button type="button" className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>前へ</button>
              <span className="mono hint">{page} / {pages}</span>
              <button type="button" className="btn sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>次へ</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function nextLabel(status: Status): string {
  const map: Partial<Record<Status, string>> = {
    received: '受付担当', review: '受付担当', wait: '承認者', approved: '受付担当', dev: '受付担当',
    verify: '受付担当', field: '受付担当', release_wait: '承認者', back: '依頼者',
  };
  return map[status] ?? '－';
}
