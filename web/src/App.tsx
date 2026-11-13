import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { session, setUnauthorizedHandler, type SessionUser } from './lib/api';
import { realtime } from './lib/realtime';
import { fleet, incidents } from './lib/stores';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';

const DevicePage = lazy(() => import('./pages/Device').then((m) => ({ default: m.DevicePage })));
const IncidentsPage = lazy(() => import('./pages/Incidents').then((m) => ({ default: m.IncidentsPage })));
const ControlPage = lazy(() => import('./pages/Control').then((m) => ({ default: m.ControlPage })));
const ReplayPage = lazy(() => import('./pages/Replay').then((m) => ({ default: m.ReplayPage })));
const ReportPage = lazy(() => import('./pages/Report').then((m) => ({ default: m.ReportPage })));
const PlatformPage = lazy(() => import('./pages/Platform').then((m) => ({ default: m.PlatformPage })));

export function App() {
  const [user, setUser] = useState<SessionUser | null>(() => (session.token ? session.user : null));

  const logout = useCallback(() => {
    session.clear();
    realtime.disconnect();
    setUser(null);
  }, []);

  useEffect(() => setUnauthorizedHandler(logout), [logout]);

  useEffect(() => {
    if (!user || !session.token) return;
    realtime.connect(session.token);
    const defaultGroups = user.groups.filter((g) => g !== 'stress' && g !== 'guest');
    void fleet.load(defaultGroups.length ? defaultGroups : user.groups);
    void incidents.load();
    return () => realtime.disconnect();
  }, [user]);

  if (!user) return <LoginPage onLogin={setUser} />;

  return (
    <BrowserRouter>
      <Suspense fallback={<div className="p-8 text-sm text-ink-3">Loading…</div>}>
        <Routes>
          <Route element={<Layout user={user} onLogout={logout} />}>
            <Route index element={<OverviewPage user={user} />} />
            <Route path="device/:id" element={<DevicePage user={user} />} />
            <Route path="incident/:id/replay" element={<ReplayPage />} />
            <Route path="incident/:id/report" element={<ReportPage />} />
            <Route path="incidents" element={<IncidentsPage user={user} />} />
            <Route path="platform" element={<PlatformPage />} />
            <Route path="control" element={user.role === 'operator' ? <ControlPage /> : <Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
