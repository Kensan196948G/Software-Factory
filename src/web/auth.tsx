import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiClientError, api, setCsrfToken } from './api.js';
import type { SessionUser } from '@shared/types.js';
import type { Role } from '@shared/domain.js';

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  switchRole: (role: Role) => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

interface LoginResponse {
  user: SessionUser;
  csrf: string;
}

export function AuthProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<{ user: SessionUser }>('/api/auth/me');
      setUser(me.user);
      setError(null);
      const csrf = await api.get<{ csrf: string | null }>('/api/auth/csrf');
      if (csrf.csrf) setCsrfToken(csrf.csrf);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        setUser(null);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : '接続できませんでした');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<LoginResponse>('/api/auth/login', { email, password });
    setCsrfToken(res.csrf);
    setUser(res.user);
    setError(null);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setCsrfToken('');
      setUser(null);
    }
  }, []);

  const switchRole = useCallback(async (role: Role) => {
    const res = await api.post<{ user: SessionUser }>('/api/auth/role', { role });
    setUser(res.user);
  }, []);

  const value = useMemo(
    () => ({ user, loading, error, login, logout, switchRole, refresh }),
    [user, loading, error, login, logout, switchRole, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('AuthProvider がありません');
  return ctx;
}
