import { memo, useDeferredValue, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, ArrowRight, Battery, CheckCircle2, Flame, Package, Search, ShieldAlert, Snowflake, Thermometer, Truck, WifiOff } from 'lucide-react';
import { STATUS_ORDER, type DeviceInfo, type DeviceState } from '@coldguard/shared';
import { fleet, incidents, platform, useStore } from '../lib/stores';
import { realtime } from '../lib/realtime';
import type { SessionUser } from '../lib/api';
import { COOLING_LABEL, STATUS_META, fmtAgo, fmtInr, fmtInt, fmtMs, fmtTemp } from '../lib/format';
import { BudgetBar, Empty, Ring, SimTag, Sparkline, Stat, StatusBadge, statusKey, useNow, type StatusKey } from '../components/bits';
import { LaneBoard } from '../components/LaneBoard';
import { IncidentCard } from '../components/IncidentCard';

type Filter = 'all' | 'attention' | StatusKey;

export function OverviewPage({ user }: { user: SessionUser }) {
  useStore(fleet);
  useStore(incidents);
  const now = useNow();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const dq = useDeferredValue(query);

  const devices = [...fleet.devices.values()];
  const rules = fleet.rules;
  const counts = { healthy: 0, warning: 0, critical: 0, offline: 0, nodata: 0 };
  let dosesAtRisk = 0;
  let valueAtRisk = 0;
  for (const d of devices) {
    const k = statusKey(fleet.states.get(d.id));
    counts[k]++;
    if (k === 'critical' || k === 'warning') {
      dosesAtRisk += d.simulatedDoses;
      valueAtRisk += d.simulatedValueInr;
    }
  }
  const reporting = devices.length - counts.nodata;
  const active = incidents.active().filter((i) => fleet.devices.has(i.deviceId));
  const worst = active[0];
  const worstDev = worst ? fleet.devices.get(worst.deviceId) : undefined;
  const worstState = worst ? fleet.states.get(worst.deviceId) : undefined;
  const mood = !worst ? 'ok' : worst.severity === 'critical' ? 'crit' : 'warn';
  const temps = devices
    .map((d) => fleet.states.get(d.id))
    .filter((x) => x && x.status !== 'offline' && x.tc != null)
    .map((x) => x!.tc!)
    .sort((a, b) => a - b);
  const median = temps.length ? (temps.length % 2 ? temps[temps.length >> 1] : (temps[(temps.length >> 1) - 1] + temps[temps.length >> 1]) / 2) : null;
  const hour = new Date(now).getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = user.displayName.split(/[\s(]/)[0];
  const healthyPct = reporting > 0 ? (counts.healthy / reporting) * 100 : 0;

  const rows = useMemo(() => {
    const q = dq.trim().toLowerCase();
    return devices
      .filter((d) => {
        const k = statusKey(fleet.states.get(d.id));
        if (filter === 'attention' && !(k === 'critical' || k === 'warning' || k === 'offline')) return false;
        if (filter !== 'all' && filter !== 'attention' && k !== filter) return false;
        if (!q) return true;
        return `${d.id} ${d.name} ${d.product} ${d.origin} ${d.destination}`.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const sa = fleet.states.get(a.id);
        const sb = fleet.states.get(b.id);
        const ka = statusKey(sa);
        const kb = statusKey(sb);
        const oa = ka === 'nodata' ? 9 : STATUS_ORDER[ka];
        const ob = kb === 'nodata' ? 9 : STATUS_ORDER[kb];
        if (oa !== ob) return oa - ob;
        return a.id.localeCompare(b.id);
      });
    // Recompute when the store version changes (states mutate in place).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet.version, dq, filter]);

  const toggleGroup = (g: string) => {
    const cur = fleet.selectedGroups;
    const next = cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g];
    if (next.length) void fleet.load(next);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* What is wrong, right now */}
      <section aria-label="Situation" className={`hero px-6 py-7 sm:px-10 sm:py-9 ${mood === 'crit' ? 'hero-crit' : mood === 'warn' ? 'hero-warn' : ''}`}>
        <div className="relative flex flex-wrap items-center gap-8">
          <div className="min-w-0 flex-1 basis-[420px]">
            <div className="flex items-center gap-2 text-[11px] font-bold tracking-[0.22em] text-teal-200 uppercase">
              <span className="live-dot h-2 w-2 rounded-full bg-teal-300" aria-hidden /> Live mission control
            </div>
            {fleet.loading ? (
              <h1 className="mt-4 text-3xl font-bold tracking-tight">Loading fleet…</h1>
            ) : worst && worstDev ? (
              <>
                <h1 className="mt-4 text-3xl leading-[1.15] font-bold tracking-tight sm:text-[40px]">
                  {greeting}, {firstName}.{' '}
                  <span className={mood === 'crit' ? 'text-rose-300' : 'text-amber-300'}>
                    {active.length} {active.length === 1 ? 'incident needs' : 'incidents need'} attention.
                  </span>
                </h1>
                <p className="mt-3 max-w-2xl text-[15px] text-slate-200">
                  Start with <b className="text-white">{worstDev.id}</b> ({worstDev.name}) — {worstState?.reasons.join(' · ')} · now {fmtTemp(worstState?.tc)} ·{' '}
                  {fmtInt(worstDev.simulatedDoses)} doses <SimTag />
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                  <Link to={`/device/${worstDev.id}`} className="btn btn-glow px-5 py-2.5 text-sm">
                    Investigate {worstDev.id} <ArrowRight size={16} aria-hidden />
                  </Link>
                  <Link to="/incidents" className="btn btn-ghost px-5 py-2.5 text-sm">
                    <ShieldAlert size={16} aria-hidden /> All incidents
                  </Link>
                </div>
              </>
            ) : (
              <>
                <h1 className="mt-4 text-3xl leading-[1.15] font-bold tracking-tight sm:text-[40px]">
                  {greeting}, {firstName}. <span className="gradient-text">Your cold chain is live.</span>
                </h1>
                <p className="mt-3 max-w-2xl text-[15px] text-slate-200">
                  {reporting} of {devices.length} loggers reporting · all within {rules?.tempLowC ?? 2}–{rules?.tempHighC ?? 8} °C. No open incidents in your corridors — alerts
                  appear here first.
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                  <a href="#list-h" className="btn btn-glow px-5 py-2.5 text-sm">
                    Explore live fleet <ArrowRight size={16} aria-hidden />
                  </a>
                  <Link to="/incidents" className="btn btn-ghost px-5 py-2.5 text-sm">
                    <CheckCircle2 size={16} aria-hidden /> Incident history
                  </Link>
                </div>
              </>
            )}
          </div>
          {/* Fleet median temperature, from live states */}
          <div className="relative mx-auto hidden h-[220px] w-[220px] shrink-0 sm:block" aria-label={median == null ? 'Fleet median temperature: no data' : `Fleet median temperature ${median.toFixed(1)} °C`} role="img">
            <div className="orbit absolute inset-0 rounded-full border border-white/15">
              <span className="absolute top-3 left-8 h-2 w-2 rounded-full bg-teal-300" />
              <span className="absolute right-1 bottom-16 h-2 w-2 rounded-full bg-amber-300" />
            </div>
            <div className="orbit-rev absolute inset-5 rounded-full border border-white/10">
              <span className="absolute bottom-1 left-10 h-1.5 w-1.5 rounded-full bg-violet-300" />
              <span className="absolute top-6 right-2 h-1.5 w-1.5 rounded-full bg-sky-300" />
            </div>
            <div className={`breathe absolute inset-[42px] flex flex-col items-center justify-center rounded-full ${mood === 'crit' ? 'orb-crit' : mood === 'warn' ? 'orb-warn' : 'orb'}`}>
              <Snowflake size={20} className="text-white/90" aria-hidden />
              <div className="mt-0.5 text-[30px] leading-none font-bold text-white tabular">{median == null ? '—' : `${median.toFixed(1)}°`}</div>
              <div className="mt-1 text-[9px] font-bold tracking-[0.18em] text-white/80 uppercase">Fleet median</div>
            </div>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Corridors">
        <span className="label mr-1">Corridors</span>
        {user.groups.map((g) => {
          const on = fleet.selectedGroups.includes(g);
          return (
            <button key={g} aria-pressed={on} onClick={() => toggleGroup(g)} className={`btn btn-sm ${on ? 'border-ice text-ice' : 'text-ink-3'}`}>
              {fleet.groups.find((x) => x.id === g)?.name ?? g}
            </button>
          );
        })}
        <span className="basis-full text-[11px] text-ink-3 sm:basis-auto">Changing corridors re-subscribes this tab's Socket.IO rooms; other users are unaffected.</span>
      </div>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Fleet status">
        <Stat icon={Truck} accent="blue" label="Monitored loggers" value={devices.length} sub={`${reporting} reporting`} />
        <div className="panel stat-card flex min-w-0 items-center gap-2 px-4 py-3.5">
          <span className="stat-blob bg-emerald-100" aria-hidden />
          <div className="relative flex min-w-0 flex-1 items-start gap-3">
            <span className="icon-tile bg-emerald-100 text-emerald-600">
              <Snowflake size={20} aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-ink-2">Healthy</div>
              <div className="mt-0.5 text-[26px] leading-tight font-bold tracking-tight tabular">{counts.healthy}</div>
              <div className="mt-0.5 text-xs text-ink-3">within range</div>
            </div>
          </div>
          <span className="relative hidden xl:block">
            <Ring pct={healthyPct} />
          </span>
        </div>
        <Stat icon={AlertTriangle} accent="amber" label="Warning" value={counts.warning} tone={counts.warning ? 'text-warn' : ''} sub="drift · pending breach · battery" />
        <Stat icon={Flame} accent="red" label="Critical" value={counts.critical} tone={counts.critical ? 'text-crit' : ''} alert={counts.critical > 0} sub="sustained excursion" />
        <Stat icon={WifiOff} accent="slate" label="Offline" value={counts.offline} tone={counts.offline ? 'text-off' : ''} sub={`no data > ${rules?.offlineSec ?? 15}s`} />
        <Stat
          icon={Package}
          accent="violet"
          label="Exposure at risk"
          value={
            <span>
              {fmtInt(dosesAtRisk)} <span className="text-sm text-ink-3">doses</span>
            </span>
          }
          sub={
            <span>
              {fmtInr(valueAtRisk)} <SimTag />
            </span>
          }
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className="panel flex min-h-[340px] flex-col p-3" aria-labelledby="board-h">
          <div className="flex items-center gap-2 px-1">
            <h2 id="board-h" className="text-sm font-semibold">
              Lane board
            </h2>
            <span className="text-[11px] text-ink-3">● shipment (position from simulated GPS progress) ■ cold room · click to investigate</span>
          </div>
          <div className="mt-2 min-h-0 flex-1">
            <LaneBoard devices={devices} states={fleet.states} highlight={worst?.deviceId} />
          </div>
        </section>
        <section className="panel flex max-h-[520px] flex-col p-3" aria-labelledby="inc-h">
          <div className="flex items-center gap-2 px-1">
            <h2 id="inc-h" className="text-sm font-semibold">
              Open incidents
            </h2>
            <span className="rounded-full bg-panel-2 px-2 text-xs tabular">{active.length}</span>
            <Link to="/incidents" className="ml-auto text-xs text-ice hover:underline">
              All incidents
            </Link>
          </div>
          <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            {active.length === 0 ? (
              <Empty icon={CheckCircle2} title="No open incidents">
                Use the Control centre (operator) to inject a cooling failure and watch the drift warning, then the excursion alert, appear here.
              </Empty>
            ) : (
              active.map((i) => <IncidentCard key={i.id} i={i} canAck={user.role === 'operator'} compact />)
            )}
          </div>
        </section>
      </div>

      <section className="panel p-3" aria-labelledby="list-h">
        <div className="flex flex-wrap items-center gap-2 px-1">
          <h2 id="list-h" className="text-sm font-semibold">
            Shipments &amp; cold rooms
          </h2>
          <span className="text-xs text-ink-3 tabular">
            {rows.length} shown
          </span>
          <div className="flex w-full flex-wrap items-center gap-2 lg:ml-auto lg:w-auto">
            <div className="flex flex-wrap gap-1" role="group" aria-label="Status filter">
              {(['all', 'attention', 'critical', 'warning', 'offline', 'healthy'] as Filter[]).map((f) => (
                <button key={f} className={`btn btn-sm ${filter === f ? 'border-ice text-ice' : 'text-ink-3'}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : f === 'attention' ? 'Needs attention' : STATUS_META[f as StatusKey].label}
                </button>
              ))}
            </div>
            <label className="relative w-full sm:w-auto">
              <span className="sr-only">Search shipments</span>
              <Search size={14} className="absolute top-2 left-2.5 text-ink-3" aria-hidden />
              <input className="input w-full pl-8 sm:w-56" placeholder="Search id, city, product…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
          </div>
        </div>
        <DeviceList rows={rows} now={now} low={rules?.tempLowC ?? 2} high={rules?.tempHighC ?? 8} />
      </section>

      <PlatformStrip />
    </div>
  );
}

const ROW_H = 56;

function DeviceList({ rows, now, low, high }: { rows: DeviceInfo[]; now: number; low: number; high: number }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_H, overscan: 8 });
  if (!rows.length) return <Empty title="No loggers match">Try another filter or search term.</Empty>;
  return (
    <div className="mt-2">
      <div className="hidden grid-cols-[110px_minmax(0,1.6fr)_96px_130px_90px_60px_64px_100px_96px] gap-3 border-b border-line px-3 pb-2 lg:grid">
        {['Status', 'Logger', 'Temp', 'Last ~3 min', 'Heat budget', 'RH', 'Battery', 'Cooling', 'Last seen'].map((h) => (
          <div key={h} className="label">
            {h}
          </div>
        ))}
      </div>
      <div ref={parentRef} className="max-h-[480px] overflow-y-auto" role="list" aria-label="Loggers">
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((vi) => {
            const d = rows[vi.index];
            return (
              <div key={d.id} role="listitem" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_H, transform: `translateY(${vi.start}px)` }}>
                <DeviceRow d={d} s={fleet.states.get(d.id)} spark={fleet.sparks.get(d.id)} sparkLen={fleet.sparks.get(d.id)?.length ?? 0} now={now} low={low} high={high} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const DeviceRow = memo(
  function DeviceRow({ d, s, spark, now, low, high }: { d: DeviceInfo; s?: DeviceState; spark?: number[]; sparkLen: number; now: number; low: number; high: number }) {
    const nav = useNavigate();
    const k = statusKey(s);
    const tempCls = s?.tc == null ? '' : s.tc > high || s.tc < low ? 'text-crit' : '';
    return (
      <button
        onClick={() => nav(`/device/${d.id}`)}
        className="grid h-full w-full grid-cols-[96px_minmax(0,1fr)_80px] items-center gap-3 border-b border-line/60 px-3 text-left hover:bg-panel-2/70 lg:grid-cols-[110px_minmax(0,1.6fr)_96px_130px_90px_60px_64px_100px_96px]"
        aria-label={`${d.id} ${d.name}, ${STATUS_META[k].label}, ${fmtTemp(s?.tc)}`}
      >
        <StatusBadge status={k} size="sm" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">
            <span className="text-ink-3">{d.id}</span> {d.name}
          </div>
          <div className="truncate text-[11px] text-ink-3">
            {s?.reasons.length ? s.reasons.join(' · ') : d.product}
          </div>
        </div>
        <div className={`flex items-center gap-1 text-base font-semibold tabular ${tempCls}`}>
          <Thermometer size={14} className="text-ink-3" aria-hidden />
          {fmtTemp(s?.tc)}
        </div>
        <div className="hidden lg:block">
          <Sparkline values={spark ?? []} low={low} high={high} color={k === 'critical' ? '#dc2626' : k === 'warning' ? '#d97706' : '#0891b2'} />
        </div>
        <div className="hidden pr-2 lg:block">
          <BudgetBar used={s?.exposure ?? 0} budget={fleet.rules?.exposureBudgetCMin ?? 20} compact />
        </div>
        <div className="hidden text-sm text-ink-2 tabular lg:block">{s?.h != null ? `${s.h.toFixed(0)}%` : '—'}</div>
        <div className={`hidden items-center gap-1 text-sm tabular lg:flex ${s?.b != null && s.b < 20 ? 'text-warn' : 'text-ink-2'}`}>
          <Battery size={13} aria-hidden />
          {s?.b != null ? `${s.b.toFixed(0)}%` : '—'}
        </div>
        <div className={`hidden text-sm lg:block ${s?.cs === 2 ? 'font-semibold text-crit' : 'text-ink-2'}`}>{s?.cs != null ? COOLING_LABEL[s.cs] : '—'}</div>
        <div className="hidden text-xs text-ink-3 tabular lg:block">{fmtAgo(s?.r, now)}</div>
      </button>
    );
  },
  (a, b) => a.s === b.s && a.now === b.now && a.sparkLen === b.sparkLen && a.d === b.d && a.low === b.low && a.high === b.high,
);

function PlatformStrip() {
  useStore(platform);
  const m = platform.latest;
  const p50 = realtime.deliveryMs.pct(50);
  return (
    <section className="panel flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 text-xs" aria-label="Platform health (measured)">
      <span className="label">Platform health · measured</span>
      <span>
        <span className="text-ink-3">ingest</span> <b className="tabular">{m ? fmtInt(m.ingest.persistedPerSec) : '—'}</b> ev/s
      </span>
      <span>
        <span className="text-ink-3">queue</span> <b className="tabular">{m ? fmtInt(m.queue.depth) : '—'}</b>
      </span>
      <span>
        <span className="text-ink-3">DB batch p95</span> <b className="tabular">{fmtMs(m?.db.batchP95)}</b>
      </span>
      <span>
        <span className="text-ink-3">server pipeline p95</span> <b className="tabular">{fmtMs(m?.pipeline.p95)}</b>
      </span>
      <span title="Server receivedAt → this tab, clock-offset corrected (± RTT/2). Only measured while a device view is open.">
        <span className="text-ink-3">delivery to this tab p50</span> <b className="tabular">{p50 == null ? '—' : fmtMs(p50)}</b>
      </span>
      <span>
        <span className="text-ink-3">sockets</span> <b className="tabular">{m?.sockets.connected ?? '—'}</b>
      </span>
      <Link to="/platform" className="ml-auto text-ice hover:underline">
        Details
      </Link>
    </section>
  );
}
