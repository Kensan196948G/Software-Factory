import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.js';
import { Banner, Skeleton } from '../components/ui.js';

interface AuditRow {
  id: number;
  at: string;
  actor: string;
  role: string;
  action: string;
  targetType: string;
  targetId: string | null;
  result: string;
  correlationId: string | null;
  hash: string;
}

export function Audit(): React.ReactElement {
  const [items, setItems] = useState<AuditRow[] | null>(null);
  const [chain, setChain] = useState<{ ok: boolean; checked: number; brokenAt?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ items: AuditRow[]; chain: { ok: boolean; checked: number; brokenAt?: number } }>('/api/audit-logs?limit=200')
      .then((r) => {
        setItems(r.items);
        setChain(r.chain);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  if (error) return <Banner kind="err">{error}</Banner>;
  if (!items) return <Skeleton lines={6} />;

  return (
    <>
      <Banner kind={chain?.ok ? 'ok' : 'err'}>
        {chain?.ok ? `監査ログのハッシュ連鎖は正常です（${chain.checked} 件）。` : `監査ログのハッシュ連鎖が壊れています（id=${chain?.brokenAt}）。`}
      </Banner>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日時</th><th>操作者</th><th>役割</th><th>操作</th><th>対象</th><th>結果</th><th>ハッシュ</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td className="mono">{new Date(r.at).toLocaleString('ja-JP')}</td>
                <td>{r.actor}</td>
                <td>{r.role}</td>
                <td className="mono">{r.action}</td>
                <td className="mono">{r.targetType}{r.targetId ? `:${r.targetId}` : ''}</td>
                <td>
                  <span className={`pill ${r.result === 'success' ? 'ok' : r.result === 'denied' ? 'y' : 'r'} plain`}>{r.result}</span>
                </td>
                <td className="mono" title={r.hash}>{r.hash.slice(0, 12)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
