import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.js';
import { useAuth } from '../auth.js';
import { Banner, useToast } from '../components/ui.js';
import type { MetaResponse } from '@shared/types.js';

export function Data(): React.ReactElement {
  const { user } = useAuth();
  const toast = useToast();
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<MetaResponse>('/api/meta').then(setMeta).catch(() => undefined);
  }, []);

  const onImport = async () => {
    if (!file) return;
    if (!window.confirm('いまのデータを置き換えます。よろしいですか？')) return;
    setBusy(true);
    setError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { items?: unknown[]; seq?: number };
      if (!Array.isArray(parsed.items)) throw new Error('items が配列ではありません');
      const res = await api.post<{ count: number }>('/api/import', { items: parsed.items, seq: parsed.seq });
      toast.push(`${res.count} 件を取り込みました`);
      setFile(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onReset = async () => {
    if (!window.confirm('見本データ9件に戻します。いまのデータは消えます。よろしいですか？')) return;
    setBusy(true);
    try {
      await api.post('/api/admin/reset-demo');
      toast.push('見本データに戻しました');
    } catch (err) {
      toast.push(errorMessage(err), { kind: 'err' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error ? <Banner kind="err">{error}</Banner> : null}
      <div className="grid-2">
        <section className="card">
          <h3>CSV（一覧）</h3>
          <p className="hint">Excelで開ける形（UTF-8 BOM・11列・CRLF）。</p>
          <a className="btn" href="/api/export.csv">CSVをダウンロード</a>
        </section>
        <section className="card">
          <h3>JSON（全データ）</h3>
          <p className="hint">バックアップと移行用（{'{seq, items}'} 形式）。</p>
          <a className="btn" href="/api/export.json">JSONを書き出す</a>
        </section>
      </div>

      <section className="card">
        <h3>取り込み（JSON）</h3>
        <p className="hint">形式を検証してから、全件を置き換えます。不正なファイルは取り込みません。</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="取り込むJSONファイル" />
          <button type="button" className="btn" disabled={!file || busy || !meta?.allowImport} onClick={() => void onImport()}>
            取り込む
          </button>
        </div>
        {!meta?.allowImport ? <div className="hint">この環境では取り込みが無効です。</div> : null}
      </section>

      {user?.isAdmin ? (
        <section className="card">
          <h3>開発用</h3>
          <p className="hint">見本データ9件に戻します（開発・検証環境のみ）。</p>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void onReset()}>
            見本データに戻す
          </button>
        </section>
      ) : null}

      <section className="card">
        <h3>この環境</h3>
        <dl className="dl">
          <dt>バージョン</dt><dd className="mono">{meta?.version ?? '—'}（{meta?.commit ?? '—'}）</dd>
          <dt>環境</dt><dd>{meta?.environment ?? '—'}</dd>
          <dt>認証</dt><dd>{meta?.authMode === 'access' ? 'Cloudflare Access（ワンタイムパスワード）' : 'パスワードログイン'}</dd>
          <dt>GitHub連携</dt><dd>{meta?.githubConfigured ? '有効（Issue自動作成）' : '未設定'}</dd>
          <dt>現在時刻</dt><dd className="mono">{meta ? new Date(meta.now).toLocaleString('ja-JP') : '—'}</dd>
        </dl>
      </section>
    </>
  );
}
