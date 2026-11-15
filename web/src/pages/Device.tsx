import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Battery, Download, TrendingUp, Droplets, Fan, Flame, Play, Pause, RefreshCw, Thermometer, Clock, Database, ZoomIn } from 'lucide-react';
import type { DeviceInfo, DeviceState, Rules } from '@coldguard/shared';
import { api, downloadFile, type SessionUser } from '../lib/api';
import { DeviceStream, RANGES } from '../lib/deviceStream';
import { fleet, incidents, useStore } from '../lib/stores';
import { realtime } from '../lib/realtime';
import { COOLING_LABEL, fmtAgo, fmtDuration, fmtInr, fmtInt, fmtMs, fmtTemp, fmtTime } from '../lib/format';
import { BudgetBar, Empty, PhasePill, SimTag, StatusBadge, statusKey, useNow } from '../components/bits';
import { TelemetryChart } from '../components/TelemetryChart';
import { IncidentCard } from '../components/IncidentCard';
import { ResponsePanel } from '../components/ResponsePanel';
import { NetworkPanel } from '../components/NetworkPanel';
import { EvidencePanel } from '../components/EvidencePanel';

export function DevicePage({ user }: { user: SessionUser }) {
  const { id = '' } = useParams();
  const [rangeMs, setRangeMs] = useState(RANGES[1].ms);
  const [stream, setStream] = useState<DeviceStream | null>(null);

  // One stream per device; created in an effect so StrictMode/unmount always disposes
  // its Socket.IO listeners and room subscription.
  useEffect(() => {
    const s = new DeviceStream(id, rangeMs);
    setStream(s);
    void s.load(rangeMs);
    return () => s.dispose();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (stream && stream.rangeMs !== rangeMs) void stream.load(rangeMs);
  }, [stream, rangeMs]);

  if (!stream || stream.deviceId !== id) return <div className="p-6 text-sm text-ink-3">Loading…</div>;
  return <DeviceView key={id} id={id} user={user} stream={stream} rangeMs={rangeMs} setRangeMs={setRangeMs} />;
}

function DeviceView({
  id,
  user,
  stream,
  rangeMs,
  setRangeMs,
}: {
  id: string;
  user: SessionUser;
  stream: DeviceStream;
  rangeMs: number;
  setRangeMs: (n: number) => void;
}) {
  const [info, setInfo] = useState<{ device: DeviceInfo; state: DeviceState; rules: Rules } | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setNotFound(false);
    api<{ device: DeviceInfo; state: DeviceState; rules: Rules }>(`/devices/${encodeURIComponent(id)}`, { signal: ac.signal })
      .then(setInfo)
      .catch((e) => e?.name !== 'AbortError' && setNotFound(true));
    return () => ac.abort();
  }, [id]);

  const version = useStore(stream);
  useStore(fleet);
  useStore(incidents);
  const now = useNow();

  if (notFound)
    return (
      <Empty title="Logger not found or not in your corridors">
        <Link to="/" className="text-ice">
          Back to overview
        </Link>
      </Empty>
    );

  const dev = fleet.devices.get(id) ?? info?.device;
  // Live state comes from the fleet subscription when this device's corridor is shown; otherwise derive from the stream.
  const st: DeviceState | undefined = fleet.states.get(id) ?? info?.state;
  const latest = stream.window.items[stream.window.items.length - 1];
  const rules = fleet.rules ?? info?.rules ?? null;
  const devIncidents = incidents.forDevice(id);
  const chartIncidents = devIncidents.filter((i) => (i.resolvedAt ?? Date.now()) >= Date.now() - rangeMs - 60_000);
  const tc = st?.tc ?? latest?.tc;
  const k = statusKey(st);
  const [exporting, setExporting] = useState<string | null>(null);
  const exportCsv = async () => {
    setExporting('Exporting…');
    try {
      const to = Date.now();
      const { truncated } = await downloadFile(`/telemetry/${encodeURIComponent(id)}/export.csv?from=${to - rangeMs}&to=${to}`, `coldguard-${id}.csv`);
      setExporting(truncated ? 'Exported the first 100,000 rows' : null);
    } catch {
      setExporting('Export failed');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/" className="btn btn-sm" aria-label="Back to overview">
          <ArrowLeft size={14} aria-hidden /> Overview
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          <span className="text-ink-3">{id}</span> {dev?.name ?? ''}
        </h1>
        <StatusBadge status={k} />
        <span className="text-sm text-ink-2">{st?.reasons.join(' · ')}</span>
      </div>

      {st?.eta && (
        <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-warn/50 bg-warn-bg px-3 py-2 text-sm text-warn">
          <TrendingUp size={16} aria-hidden />
          <b>
            Forecast: reaches {st.eta.limitC} °C in ≈ {fmtDuration(st.eta.sec)}
          </b>
          <span className="text-xs text-ink-2">
            {st.eta.slopeCPerMin > 0 ? 'rising' : 'falling'} {Math.abs(st.eta.slopeCPerMin).toFixed(2)} °C/min · straight-line extrapolation of the recent trend — an
            estimate, not an alert
          </span>
        </div>
      )}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7" aria-label="Current readings">
        <Reading icon={Thermometer} label="Temperature" value={fmtTemp(tc, 2)} tone={tc != null && rules && (tc > rules.tempHighC || tc < rules.tempLowC) ? 'text-crit' : ''} sub={rules ? `range ${rules.tempLowC}–${rules.tempHighC} °C (demo setting)` : ''} />
        <Reading icon={Droplets} label="Humidity" value={st?.h != null ? `${st.h.toFixed(1)} %RH` : '—'} />
        <Reading icon={Battery} label="Logger battery" value={st?.b != null ? `${st.b.toFixed(0)} %` : '—'} tone={st?.b != null && rules && st.b < rules.lowBatteryPct ? 'text-warn' : ''} />
        <Reading
          icon={Fan}
          label="Cooling · door"
          value={st?.cs != null ? COOLING_LABEL[st.cs] : '—'}
          tone={st?.cs === 2 ? 'text-crit' : st?.cs === 3 ? 'text-warn' : ''}
          sub={st?.door === 1 ? <span className="font-semibold text-warn">Door OPEN</span> : st?.door === 0 ? 'Door closed' : ''}
        />
        <div className="panel min-w-0 px-3 py-2.5" title="Cumulative degrees outside the band × minutes, from in-order readings. Demo calculation inspired by vaccine vial heat indicators — not a stability determination.">
          <div className="label flex items-center gap-1">
            <Flame size={12} aria-hidden /> Heat budget <SimTag title="Demonstration calculation" />
          </div>
          <BudgetBar used={st?.exposure ?? 0} budget={rules?.exposureBudgetCMin ?? 20} />
        </div>
        <Reading icon={Clock} label="Last reading" value={fmtAgo(st?.r, now)} sub={st?.t ? `observed ${fmtTime(st.t)}` : ''} />
        <Reading
          icon={Database}
          label="Load exposure"
          value={dev ? `${fmtInt(dev.simulatedDoses)} doses` : '—'}
          sub={
            dev ? (
              <span>
                {dev.product} · {fmtInr(dev.simulatedValueInr)} <SimTag />
              </span>
            ) : (
              ''
            )
          }
        />
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="panel min-w-0 p-3" aria-labelledby="chart-h">
          <div className="flex flex-wrap items-center gap-2 px-1">
            <h2 id="chart-h" className="text-sm font-semibold">
              Telemetry
            </h2>
            <PhasePill phase={stream.phase} />
            <span className="text-[11px] text-ink-3">
              {stream.mode === 'agg' ? `aggregated ${stream.bucketMs / 1000}s buckets (min/avg/max) + raw live tail` : 'raw readings'}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-1" role="group" aria-label="Time range">
              {RANGES.map((r) => (
                <button key={r.ms} className={`btn btn-sm ${rangeMs === r.ms ? 'border-ice text-ice' : 'text-ink-3'}`} aria-pressed={rangeMs === r.ms} onClick={() => setRangeMs(r.ms)}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
            {stream.following ? (
              <button className="btn btn-sm" onClick={() => stream.pause()}>
                <Pause size={13} aria-hidden /> Pause
              </button>
            ) : (
              <button className="btn btn-sm btn-primary" onClick={() => stream.resume()}>
                <Play size={13} aria-hidden /> Resume live
              </button>
            )}
            {stream.phase === 'refresh-required' || stream.phase === 'error' ? (
              <button className="btn btn-sm btn-danger" onClick={() => void stream.load()}>
                <RefreshCw size={13} aria-hidden /> Full refresh
              </button>
            ) : (
              <button className="btn btn-sm" onClick={() => void stream.load()} title="Reload history from MongoDB">
                <RefreshCw size={13} aria-hidden /> Reload
              </button>
            )}
            <button className="btn btn-sm" onClick={() => void exportCsv()} disabled={exporting === 'Exporting…'} title="Download the raw stored readings for the selected range as CSV">
              <Download size={13} aria-hidden /> Export CSV
            </button>
            {exporting && <span className="text-[11px] text-ink-3">{exporting}</span>}
            <span className="flex items-center gap-1 text-[11px] text-ink-3">
              <ZoomIn size={12} aria-hidden /> Drag across the chart to zoom — live data keeps merging while you inspect.
            </span>
            {stream.error && <span className="text-xs text-crit">{stream.error}</span>}
          </div>
          <div className="mt-2">
            <TelemetryChart stream={stream} version={version} rules={rules} incidents={chartIncidents} />
          </div>
          <Legend />
        </section>

        <aside className="flex min-w-0 flex-col gap-4">
          <ResponsePanel
            deviceId={id}
            state={st}
            canAct={user.role === 'operator'}
            incident={devIncidents.find((i) => i.active && (i.type === 'temp_high' || i.type === 'temp_low')) ?? devIncidents.find((i) => i.active)}
            readings={stream.window.items}
            rules={rules}
            version={version}
          />
          <NetworkPanel deviceId={id} stream={stream} canBreak={user.role === 'operator'} />
          <section className="panel p-3" aria-labelledby="tl-h">
            <h2 id="tl-h" className="px-1 text-sm font-semibold">
              Incident timeline
            </h2>
            <div className="mt-2 flex max-h-[520px] flex-col gap-2 overflow-y-auto pr-1">
              {devIncidents.length === 0 ? (
                <Empty title="No incidents for this logger">Alerts for this logger will appear here with the readings that triggered them.</Empty>
              ) : (
                devIncidents.slice(0, 12).map((i) => <IncidentCard key={i.id} i={i} canAck={user.role === 'operator'} showDevice={false} compact={!i.active} />)
              )}
            </div>
          </section>
          <EvidencePanel deviceId={id} canDemo={user.role === 'operator'} />
          <IntegrityPanel stream={stream} />
        </aside>
      </div>
    </div>
  );
}

function Reading({ icon: Icon, label, value, sub, tone }: { icon: typeof Thermometer; label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="panel min-w-0 px-3 py-2.5">
      <div className="label flex items-center gap-1">
        <Icon size={12} aria-hidden /> {label}
      </div>
      <div className={`mt-1 truncate text-lg font-semibold tabular ${tone ?? ''}`}>{value}</div>
      {sub && <div className="truncate text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}

function Legend() {
  const items = [
    ['#0891b2', 'Temperature (°C)'],
    ['rgba(8,145,178,0.4)', 'Bucket min–max'],
    ['#7c3aed', 'Late (out-of-order) reading'],
    ['#dc2626', 'Threshold / alert / cooling fault strip'],
    ['#d97706', 'Door-open strip'],
    ['#0d9488', 'Humidity %RH'],
    ['#ca8a04', 'Battery %'],
  ];
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11px] text-ink-3">
      {items.map(([c, l]) => (
        <li key={l} className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-3 rounded-sm" style={{ background: c }} aria-hidden />
          {l}
        </li>
      ))}
    </ul>
  );
}

/** Makes the history/live consistency mechanism visible. */
function IntegrityPanel({ stream }: { stream: DeviceStream }) {
  const s = stream.stats;
  const rows: [string, React.ReactNode, string][] = [
    ['History loaded', fmtInt(s.historyCount), `readings from MongoDB in ${s.loadMs} ms`],
    ['Buffered during load', fmtInt(s.bufferedDuringLoad), 'live events received while history was loading'],
    ['History/live overlap removed', fmtInt(s.overlapDeduped), 'same eventId in history and live buffer at handoff'],
    ['Duplicates dropped (total)', fmtInt(stream.window.duplicatesDropped), 'incl. catch-up overlap; dedupe by eventId'],
    ['Live received', fmtInt(s.liveReceived), 'via Socket.IO room device:' + stream.deviceId],
    ['Late readings', fmtInt(s.lateFlagged), 'out-of-order; shown, never moved current state'],
    ['Catch-ups', `${s.catchUps} (${fmtInt(s.caughtUpEvents)} ev)`, 'after reconnect, fetched by cursor'],
    ['Points in view buffer', fmtInt(stream.window.size), `bounded to 25,000 · ${fmtInt(stream.window.evicted)} evicted`],
    ['Watermark / last cursor', `${String(s.watermark).slice(-6)} / ${String(s.lastCursor).slice(-6)}`, 'commit cursors (last 6 digits)'],
  ];
  if (stream.mode === 'agg') rows.push(['Late, inside aggregated range', fmtInt(s.lateOutsideAgg), 'not drawn until refresh (defined overlap rule)']);
  const p50 = realtime.deliveryMs.pct(50);
  const p95 = realtime.deliveryMs.pct(95);
  return (
    <section className="panel p-3" aria-labelledby="int-h">
      <h2 id="int-h" className="px-1 text-sm font-semibold">
        Stream integrity <span className="font-normal text-ink-3">· measured in this tab</span>
      </h2>
      <dl className="mt-2 divide-y divide-line/70 text-xs">
        {rows.map(([k, v, hint]) => (
          <div key={k} className="flex items-baseline gap-2 px-1 py-1.5" title={hint}>
            <dt className="text-ink-2">{k}</dt>
            <dd className="ml-auto font-semibold tabular">{v}</dd>
          </div>
        ))}
        <div className="flex items-baseline gap-2 px-1 py-1.5" title="Server receivedAt → receipt in this tab, corrected by NTP-style clock offset; uncertainty ± RTT/2">
          <dt className="text-ink-2">Delivery latency p50 / p95</dt>
          <dd className="ml-auto font-semibold tabular">
            {fmtMs(p50)} / {fmtMs(p95)}
          </dd>
        </div>
        <div className="flex items-baseline gap-2 px-1 py-1.5">
          <dt className="text-ink-2">Socket RTT · chart renders</dt>
          <dd className="ml-auto font-semibold tabular">
            {fmtMs(realtime.rtt)} · {fmtInt(stream.renders)}
          </dd>
        </div>
      </dl>
    </section>
  );
}
