import { useState } from 'react';
import { useAuth } from '../auth.js';
import { errorMessage } from '../api.js';
import { Banner, Field } from '../components/ui.js';

export function Login(): React.ReactElement {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={(e) => void onSubmit(e)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="brand-mark" aria-hidden="true">
            SF
          </div>
          <div>
            <h1 style={{ fontSize: 20 }}>受付ステーション</h1>
            <div className="hint">みらいソフトウェアファクトリー</div>
          </div>
        </div>
        {error ? <Banner kind="err">{error}</Banner> : null}
        <Field label="メールアドレス" htmlFor="email" required>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="パスワード" htmlFor="password" required>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <button className="btn primary block" type="submit" disabled={busy}>
          {busy ? '確認中…' : 'ログイン'}
        </button>
        <p className="hint">
          検証環境では、管理者から配布されたアカウントでログインしてください。Cloudflare Access 配下では、この画面は表示されません。
        </p>
      </form>
    </div>
  );
}
