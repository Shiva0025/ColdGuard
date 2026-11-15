import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Activity, Bell, BellOff, BellRing, LayoutGrid, LogOut, Radio, Snowflake, SlidersHorizontal, Waypoints, WifiOff, X, Unplug } from 'lucide-react';
import { INCIDENT_LABEL } from '@coldguard/shared';
import { incidents, platform, useStore } from '../lib/stores';
import { realtime, type ConnStatus } from '../lib/realtime';
import type { SessionUser } from '../lib/api';
import { fmtTime } from '../lib/format';
import { alertPrefs, setTitleBadge } from '../lib/alerts';

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
      <span className="hidden tracking-wide sm:inline">{m.label}</span>
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

const TITLES: [RegExp, string, string][] = [
  [/^\/$/, 'Overview', 'Live operational view of every corridor you can see'],
  [/^\/incidents/, 'Incidents', 'Explained alerts, acknowledgement and response times'],
  [/^\/incident\/.+\/replay/, 'Incident replay', 'How it happened, reading by reading'],
  [/^\/incident\/.+\/report/, 'Evidence report', 'Sealed readings, verifiable offline'],
  [/^\/device\//, 'Investigation', 'History and live data merged for one logger'],
  [/^\/platform/, 'Platform', 'Measured pipeline health, not simulated'],
  [/^\/control/, 'Control centre', 'Simulator, faults, rules and judge invites'],
];

function NavItems({ user, unacked, variant }: { user: SessionUser; unacked: number; variant: 'side' | 'top' }) {
  const cls = ({ isActive }: { isActive: boolean }) =>
    variant === 'side'
      ? `nav-item ${isActive ? 'nav-item-active' : ''}`
      : `flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-white/15 text-white' : 'text-slate-300 hover:text-white'}`;
  const size = variant === 'side' ? 20 : 15;
  return (
    <>
      <NavLink to="/" end className={cls}>
        <LayoutGrid size={size} aria-hidden /> Overview
      </NavLink>
      <NavLink to="/incidents" className={cls}>
        <Bell size={size} aria-hidden /> Incidents
        {unacked > 0 && (
          <span className={`flex h-5 min-w-5 items-center justify-center rounded-full bg-crit px-1.5 text-[11px] font-bold text-white ${variant === 'side' ? 'ml-auto' : ''}`}>{unacked}</span>
        )}
      </NavLink>
      <NavLink to="/platform" className={cls}>
        <Activity size={size} aria-hidden /> Platform
      </NavLink>
      {user.role === 'operator' && (
        <NavLink to="/control" className={cls}>
          <SlidersHorizontal size={size} aria-hidden /> Control centre
        </NavLink>
      )}
    </>
  );
}

function Brand() {
  return (
    <NavLink to="/" className="flex items-center gap-3">
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-300 via-sky-400 to-indigo-500 shadow-[0_8px_24px_-6px_rgba(56,189,248,0.8)]">
        <Snowflake size={22} className="text-white" aria-hidden />
      </span>
      <span className="leading-tight">
        <span className="block text-lg font-bold tracking-tight text-white">ColdGuard</span>
        <span className="block text-[10px] font-semibold tracking-[0.18em] text-slate-400 uppercase">Cold chain intelligence</span>
      </span>
    </NavLink>
  );
}

export function Layout({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  useStore(incidents);
  const { pathname } = useLocation();
  const active = incidents.active().filter((i) => !i.ack).length;
  const [alertsOn, setAlertsOn] = useState(alertPrefs.enabled);
  useEffect(() => {
    setTitleBadge(active);
    return () => setTitleBadge(0);
  }, [active]);
  const [, title, subtitle] = TITLES.find(([re]) => re.test(pathname)) ?? TITLES[0];
  const initials = user.displayName
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, '')[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="flex min-h-full">
      {/* Sidebar (desktop) */}
      <aside className="night sticky top-0 hidden h-screen w-[264px] shrink-0 flex-col px-5 py-7 lg:flex">
        <Brand />
        <div className="mt-9 mb-2 px-3 text-[10px] font-bold tracking-[0.2em] text-slate-500 uppercase">Workspace</div>
        <nav className="flex flex-col gap-1.5" aria-label="Main">
          <NavItems user={user} unacked={active} variant="side" />
        </nav>
        <div className="mt-auto flex flex-col gap-4">
          <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              <Waypoints size={14} className="text-teal-300" aria-hidden /> {user.groups.length === 1 ? 'Your corridor' : 'Your corridors'}
            </div>
            <div className="mt-1 text-sm font-semibold text-white capitalize">{user.groups.join(' · ')}</div>
            <div className="mt-0.5 text-[11px] text-slate-400">Simulated fleet · demo thresholds</div>
          </div>
          <div className="flex items-center gap-3 border-t border-white/10 pt-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-300 to-orange-400 text-sm font-bold text-slate-900">{initials}</span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-semibold text-white">{user.displayName}</div>
              <div className="text-[11px] text-slate-400 capitalize">{user.role}</div>
            </div>
            <button className="rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white" onClick={onLogout} aria-label="Sign out" title="Sign out">
              <LogOut size={16} aria-hidden />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Compact navigation (phones and tablets) */}
        <header className="night sticky top-0 z-40 px-4 py-3 lg:hidden">
          <div className="flex items-center gap-3">
            <Brand />
            <button className="ml-auto rounded-lg p-2 text-slate-300 hover:bg-white/10" onClick={onLogout} aria-label="Sign out">
              <LogOut size={16} aria-hidden />
            </button>
          </div>
          <nav className="mt-3 flex gap-1 overflow-x-auto" aria-label="Main">
            <NavItems user={user} unacked={active} variant="top" />
          </nav>
        </header>

        {/* Page bar */}
        <div className="z-30 border-b border-line bg-white/80 backdrop-blur lg:sticky lg:top-0 print:hidden">
          <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 lg:px-8">
            <div className="min-w-0">
              <div className="text-xl font-bold tracking-tight">{title}</div>
              <div className="hidden truncate text-xs text-ink-3 sm:block">{subtitle}</div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <ConnectionPill />
              <button
                className={`btn btn-sm ${alertsOn ? 'border-ice text-ice' : ''}`}
                aria-pressed={alertsOn}
                title={alertsOn ? 'Alert sound and desktop notifications are on for new incidents — click to mute' : 'Play a sound and show a desktop notification when a new incident opens'}
                onClick={() => {
                  const next = !alertsOn;
                  setAlertsOn(next);
                  void alertPrefs.set(next);
                }}
              >
                {alertsOn ? <BellRing size={14} aria-hidden /> : <BellOff size={14} aria-hidden />}
                <span className="hidden md:inline">{alertsOn ? 'Alerts on' : 'Alerts muted'}</span>
                <span className={`relative hidden h-4 w-7 rounded-full transition-colors md:inline-block ${alertsOn ? 'bg-ok' : 'bg-line-2'}`} aria-hidden>
                  <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${alertsOn ? 'left-3.5' : 'left-0.5'}`} />
                </span>
              </button>
              <button
                className="btn btn-sm"
                title="Really disconnect this tab's socket for 8 s, then reconnect and catch up from MongoDB"
                onClick={() => realtime.simulateDrop(8000)}
              >
                <Unplug size={14} aria-hidden />
                <span className="hidden xl:inline">Drop connection</span>
              </button>
            </div>
          </div>
        </div>

        <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-5 lg:px-8">
          <Outlet />
        </main>
        <footer className="border-t border-line px-4 py-3 text-center text-[11px] text-ink-3">
          All shipments, temperatures, thresholds, dose counts and values are <b className="text-sim">simulated</b> for demonstration. Not a medical
          or regulatory decision system.
        </footer>
      </div>
      <Toasts />
    </div>
  );
}
