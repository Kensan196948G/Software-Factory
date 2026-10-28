import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api.js';
import { Banner, EmptyState, SignalPill, Skeleton } from '../components/ui.js';
import { SIGNAL_LABEL, type Signal } from '@shared/domain.js';
import type { CatalogTool, DepartmentRow } from '@shared/types.js';

interface Summary {
  departments: number;
  tools: number;
  g: number;
  y: number;
  r: number;
}

export function Catalog(): React.ReactElement {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [tools, setTools] = useState<CatalogTool[] | null>(null);
  const [dept, setDept] = useState('');
  const [signal, setSignal] = useState<'' | Signal>('');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Summary>('/api/catalog/summary').then(setSummary).catch((e) => setError(errorMessage(e)));
    api.get<{ items: DepartmentRow[] }>('/api/catalog/departments').then((r) => setDepartments(r.items)).catch(() => undefined);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (dept) params.set('dept', dept);
    if (signal) params.set('signal', signal);
    if (q.trim()) params.set('q', q.trim());
    api
      .get<{ items: CatalogTool[] }>(`/api/catalog/tools?${params.toString()}`)
      .then((r) => setTools(r.items))
      .catch((e) => setError(errorMessage(e)));
  }, [dept, signal, q]);

  const deptMap = useMemo(() => new Map(departments.map((d) => [d.code, d])), [departments]);

  if (error) return <Banner kind="err">{error}</Banner>;

  return (
    <>
      <div className="grid-3">
        <div className="stat"><div className="k">考えた部署</div><div className="v">{summary?.departments ?? 19}</div></div>
        <div className="stat"><div className="k">道具の候補</div><div className="v">{summary?.tools ?? 118}</div></div>
        <div className="stat">
          <div className="k">青 / 黄 / 赤</div>
          <div className="v" style={{ fontSize: 20 }}>
            <span style={{ color: 'var(--info)' }}>{summary?.g ?? 52}</span> / <span style={{ color: 'var(--warn)' }}>{summary?.y ?? 47}</span> / <span style={{ color: 'var(--danger)' }}>{summary?.r ?? 19}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className={`btn sm ${dept === '' ? 'primary' : ''}`} onClick={() => setDept('')}>すべて</button>
        {departments.map((d) => (
          <button key={d.code} type="button" className={`btn sm ${dept === d.code ? 'primary' : ''}`} onClick={() => setDept(d.code)} title={d.name}>
            {d.shortName}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="select" style={{ width: 120 }} value={signal} onChange={(e) => setSignal(e.target.value as '' | Signal)} aria-label="信号で絞り込み">
          <option value="">色：すべて</option>
          {(['g', 'y', 'r'] as Signal[]).map((s) => (
            <option key={s} value={s}>{SIGNAL_LABEL[s]}</option>
          ))}
        </select>
        <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="道具を検索（例：写真、請求書）" value={q} onChange={(e) => setQ(e.target.value)} aria-label="道具を検索" />
      </div>

      {!tools ? (
        <Skeleton lines={4} />
      ) : tools.length === 0 ? (
        <EmptyState title="条件に合う道具がありません" icon="⌕" />
      ) : (
        <div className="grid-2">
          {tools.map((t) => (
            <article key={t.id} className="card">
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <SignalPill signal={t.signal} />
                {t.seedCandidate ? <span className="pill brand plain">★ はじめやすい</span> : null}
                <span className="mono hint" style={{ marginLeft: 'auto' }}>{t.id}</span>
              </div>
              <h3 style={{ margin: '6px 0 2px', fontSize: 14 }}>{t.name}</h3>
              <div className="hint">{t.description}</div>
              <div className="hint" style={{ marginTop: 4 }}>{deptMap.get(t.deptCode)?.name ?? t.deptName}</div>
              {t.signal === 'r' ? (
                <div className="banner warn" style={{ marginTop: 8, fontSize: 11 }}>
                  決める仕事は対象外です。範囲を「材料集め・表示」に変えて依頼してください。
                </div>
              ) : (
                <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => navigate(`/new?tool=${encodeURIComponent(t.id)}`)}>
                  この道具で依頼を作る
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
