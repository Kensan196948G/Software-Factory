import { BrowserRouter, Route, Routes, useSearchParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.js';
import { ToastProvider } from './components/ui.js';
import { Shell } from './components/Shell.js';
import { Home } from './pages/Home.js';
import { Login } from './pages/Login.js';
import { NewRequest } from './pages/NewRequest.js';
import { Board } from './pages/Board.js';
import { List } from './pages/List.js';
import { Catalog } from './pages/Catalog.js';
import { Data } from './pages/Data.js';
import { Audit } from './pages/Audit.js';
import { DetailDrawer } from './request/DetailDrawer.js';

function AppRoutes(): React.ReactElement {
  const { user, loading } = useAuth();
  const [params, setParams] = useSearchParams();

  if (loading) {
    return (
      <div className="login-wrap">
        <div className="skeleton" style={{ width: 240, height: 16 }} />
      </div>
    );
  }
  if (!user) return <Login />;

  const requestId = params.get('request');
  const doParam = params.get('do');

  const closeDrawer = () => {
    const next = new URLSearchParams(params);
    next.delete('request');
    next.delete('do');
    setParams(next, { replace: true });
  };

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/new" element={<NewRequest />} />
        <Route path="/board" element={<Board />} />
        <Route path="/requests" element={<List />} />
        <Route path="/catalog" element={<Catalog />} />
        <Route path="/data" element={<Data />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="*" element={<Home />} />
      </Routes>
      {requestId ? <DetailDrawer id={requestId} initialDo={doParam} onClose={closeDrawer} /> : null}
    </Shell>
  );
}

export function App(): React.ReactElement {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
