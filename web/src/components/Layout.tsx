import { NavLink, Outlet, useNavigate } from 'react-router';
import { Activity, Bell, Gauge, LogOut, Radio, Snowflake, SlidersHorizontal, WifiOff, X, Unplug } from 'lucide-react';
import { INCIDENT_LABEL } from '@coldguard/shared';
import { incidents, platform, useStore } from '../lib/stores';
import { realtime, type ConnStatus } from '../lib/realtime';
import type { SessionUser } from '../lib/api';
import { fmtTime } from '../lib/format';

const CONN: Record<ConnStatus, { label: string; cls: string }> = {
  idle: { label: 'Offline', cls: 'text-off bg-off-bg' },
  connecting: { label: 'Connecting…', cls: 'text-ice bg-ice-dim/40' },
  live: { label: 'Live', cls: 'text-ok bg-ok-bg' },
  reconnecting: { label: 'Reconnecting…', cls: 'text-warn bg-warn-bg' },
  dropped: { label: 'Disconnected (demo)', cls: 'text-warn bg-warn-bg' },
};

function ConnectionPill() {
  useStore(platform);
  const s = platform.conn;
  const m = CONN[s];
  return (
    <span role="status" aria-live="polite" className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${m.cls}`}>
      {s === 'live' ? <Radio size={13} aria-hidden /> : <WifiOff size={13} aria-hidden />}
      <span className="hidden sm:inline">{m.label}</span>
    </span>
  );
}

function Toasts() {
  useStore(incidents);
  const nav = useNavigate();
  if (!incidents.toasts.length) return null;
  return (
    <div className="pointer-events-none fixed right-3 bottom-3 z-50 flex w-[min(380px,calc(100vw-24px))] flex-col gap-2" aria-live="assertive">
      {incidents.toasts.map((t) => {
        const crit = t.incident.severity === 'critical';
        return (
          <div key={t.id} className={`panel pointer-events-auto flex gap-3 p-3 shadow-xl ${crit ? 'border-crit/60' : 'border-warn/50'}`}>
            <Bell size={18} className={crit ? 'text-crit' : 'text-warn'} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">
                {INCIDENT_LABEL[t.incident.type]} · {t.incident.deviceId}
              </div>
              <div className="mt-0.5 line-clamp-2 text-xs text-ink-2">{t.incident.explanation}</div>
              <div className="mt-2 flex gap-2">
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    incidents.dismiss(t.id);
                    nav(`/device/${t.incident.deviceId}`);
                  }}
                >
                  Investigate
                </button>
                <span className="self-center text-[11px] text-ink-3">{fmtTime(t.incident.triggeredAt)}</span>
              </div>
            </div>
            <button aria-label="Dismiss notification" className="self-start text-ink-3 hover:text-ink" onClick={() => incidents.dismiss(t.id)}>
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function Layout({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  useStore(incidents);
  const active = incidents.active().filter((i) => !i.ack).length;
  const link = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium ${isActive ? 'bg-panel-2 text-ink' : 'text-ink-2 hover:text-ink'}`;
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <Snowflake size={20} className="text-ice" aria-hidden />
            <span>ColdGuard</span>
            <span className="hidden text-xs font-normal text-ink-3 md:inline">cold-chain operations · simulated fleet</span>
          </NavLink>
          <nav className="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto" aria-label="Main">
            <NavLink to="/" end className={link}>
              <Gauge size={15} aria-hidden /> Overview
            </NavLink>
            <NavLink to="/incidents" className={link}>
              <Bell size={15} aria-hidden /> Incidents
              {active > 0 && <span className="rounded-full bg-crit px-1.5 text-[11px] font-bold text-white">{active}</span>}
            </NavLink>
            <NavLink to="/platform" className={link}>
              <Activity size={15} aria-hidden /> Platform
            </NavLink>
            {user.role === 'operator' && (
              <NavLink to="/control" className={link}>
                <SlidersHorizontal size={15} aria-hidden /> Control centre
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ConnectionPill />
            <button
              className="btn btn-sm"
              title="Really disconnect this tab's socket for 8 s, then reconnect and catch up from MongoDB"
              onClick={() => realtime.simulateDrop(8000)}
            >
              <Unplug size={14} aria-hidden />
              <span className="hidden lg:inline">Drop connection</span>
            </button>
            <div className="hidden text-right leading-tight sm:block">
              <div className="text-xs font-semibold">{user.displayName}</div>
              <div className="text-[11px] text-ink-3">
                {user.role} · {user.groups.join(', ')}
              </div>
            </div>
            <button className="btn btn-sm" onClick={onLogout} aria-label="Sign out">
              <LogOut size={14} aria-hidden />
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-4">
        <Outlet />
      </main>
      <footer className="border-t border-line px-4 py-3 text-center text-[11px] text-ink-3">
        All shipments, temperatures, thresholds, dose counts and values are <b className="text-sim">simulated</b> for demonstration. Not a medical
        or regulatory decision system.
      </footer>
      <Toasts />
    </div>
  );
}
