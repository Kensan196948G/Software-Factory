import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.js';
import { ROLE_LABEL, type Role } from '@shared/domain.js';

interface HomeCounts {
  counts: { yourTurn: number };
}

export function Shell({ children }: { children: ReactNode }): React.ReactElement {
  const { user, switchRole, logout } = useAuth();
  const [yourTurn, setYourTurn] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    api
      .get<HomeCounts>('/api/home')
      .then((r) => {
        if (!cancelled) setYourTurn(r.counts.yourTurn);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user?.actingRole, location.pathname]);

  if (!user) return <>{children}</>;

  const onSwitch = async (role: Role) => {
    if (role === user.actingRole) return;
    await switchRole(role);
    navigate(location.pathname);
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        本文へ
      </a>
      <aside className="side" aria-label="メインナビゲーション">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            SF
          </div>
          <div>
            <b>みらいSF</b>
            <span>受付ステーション</span>
          </div>
        </div>
        <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive ? 'on' : ''}`} aria-current={location.pathname === '/' ? 'page' : undefined}>
          <span className="ico" aria-hidden="true">◧</span>
          <span className="label">ホーム</span>
          {yourTurn > 0 ? <span className="badge" aria-label={`あなたの番 ${yourTurn}件`}>{yourTurn}</span> : null}
        </NavLink>
        <NavLink to="/new" className={({ isActive }) => `nav-item ${isActive ? 'on' : ''}`}>
          <span className="ico" aria-hidden="true">＋</span>
          <span className="label">新しい依頼</span>
        </NavLink>
        <NavLink to="/board" className={({ isActive }) => `nav-item ${isActive ? 'on' : ''}`}>
          <span className="ico" aria-hidden="true">▤</span>
          <span className="label">ボード</span>
        </NavLink>
        <NavLink to="/requests" className={({ isActive }) => `nav-item ${isActive ? 'on' : ''}`}>
          <span className="ico" aria-hidden="true">☰</span>
          <span className="label">一覧</span>
        </NavLink>
        <NavLink to="/catalog" className={({ isActive }) => `nav-item optional ${isActive ? 'on' : ''}`}>
          <span className="ico" aria-hidden="true">◫</span>
          <span className="label">カタログ</span>
        </NavLink>
        <NavLink to="/data" className={({ isActive }) => `nav-item optional ${isActive ? 'on' : ''}`}>
          <span className="ico" aria-hidden="true">⇩</span>
          <span className="label">データ</span>
        </NavLink>
        {user.isAdmin ? (
          <NavLink to="/audit" className={({ isActive }) => `nav-item optional ${isActive ? 'on' : ''}`}>
            <span className="ico" aria-hidden="true">◎</span>
            <span className="label">監査ログ</span>
          </NavLink>
        ) : null}
        <div className="side-foot">
          <div className="role-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#1b3a35', border: '1px solid #2c554e', borderRadius: 999, padding: '3px 10px', color: '#d7e5e2', fontSize: 10.5 }}>
            <span aria-hidden="true">●</span> {ROLE_LABEL[user.actingRole]}として操作中
          </div>
          <div style={{ marginTop: 8 }}>{user.displayName}</div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div>
            <div className="crumb">みらいSF 受付ステーション</div>
            <h3>{pageTitle(location.pathname)}</h3>
          </div>
          <div className="topbar-right">
            <div className="role-switch" role="group" aria-label="役割の切替（検証用）">
              {user.roles.map((role) => (
                <button
                  key={role}
                  type="button"
                  className={role === user.actingRole ? 'on' : ''}
                  aria-pressed={role === user.actingRole}
                  onClick={() => void onSwitch(role)}
                >
                  {ROLE_LABEL[role]}
                </button>
              ))}
            </div>
            <button type="button" className="btn sm" onClick={() => void logout()}>
              ログアウト
            </button>
          </div>
        </header>
        <main id="main" className="content">
          {children}
        </main>
      </div>
    </div>
  );
}

function pageTitle(pathname: string): string {
  if (pathname === '/') return 'ホーム';
  if (pathname.startsWith('/new')) return '新しい依頼';
  if (pathname.startsWith('/board')) return 'ボード';
  if (pathname.startsWith('/requests')) return '依頼一覧';
  if (pathname.startsWith('/catalog')) return 'カタログ';
  if (pathname.startsWith('/data')) return 'データ';
  if (pathname.startsWith('/audit')) return '監査ログ';
  return 'みらいSF';
}
