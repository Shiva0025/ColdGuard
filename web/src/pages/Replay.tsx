import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import uPlot from 'uplot';
import { ArrowLeft, DoorOpen, DoorClosed, Fan, Pause, Play, SkipBack, Lightbulb, Droplets, Thermometer, Info } from 'lucide-react';
import { CITIES, INCIDENT_LABEL, excessDegMin, type Command, type DeviceInfo, type Incident, type Reading, type Rules } from '@coldguard/shared';
import { api } from '../lib/api';
import { COOLING_LABEL, fmtTime } from '../lib/format';
import { BudgetBar, Empty } from '../components/bits';

interface StoryEvent {
  t: number;
  kind: string;
  title: string;
  detail?: string;
  severity: 'info' | 'warning' | 'critical' | 'ok';
  eventId?: string;
}
interface Factor {
  title: string;
  relation: string;
  evidence: string[];
  caveat: string;
}
interface ReplayData {
  incident: Incident;
  device: DeviceInfo;
  from: number;
  to: number;
  readings: Reading[];
  commands: Command[];
  rules: Rules;
  events: StoryEvent[];
  factors: Factor[];
  onsetAt: number | null;
  firstBreachAt: number | null;
}

const SEV = { info: '#6cd3ff', warning: '#f0b429', critical: '#ff5d5d', ok: '#3ecf8e' };
const SPEEDS = [10, 30, 60, 120];

/** Latest reading at or before t (binary search). */
function at(rs: Reading[], t: number): Reading | undefined {
  let lo = 0;
  let hi = rs.length - 1;
  let best: Reading | undefined;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (rs[m].t <= t) {
      best = rs[m];
      lo = m + 1;
    } else hi = m - 1;
  }
  return best;
}

export function ReplayPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<ReplayData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(30);

  useEffect(() => {
    const ac = new AbortController();
    api<ReplayData>(`/incidents/${encodeURIComponent(id)}/replay`, { signal: ac.signal })
      .then((d) => {
        setData(d);
        setT(d.readings[0]?.t ?? d.from);
      })
      .catch((e) => e?.name !== 'AbortError' && setErr(e.message));
    return () => ac.abort();
  }, [id]);

  // Playback loop: advance the playhead by `speed` × real time.
  useEffect(() => {
    if (!playing || !data) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      setT((cur) => {
        const next = cur + dt * speed;
        if (next >= data.to) {
          setPlaying(false);
          return data.to;
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, data]);

  if (err) return <Empty title="Replay unavailable">{err}</Empty>;
  if (!data) return <div className="p-6 text-sm text-ink-3">Reconstructing incident from MongoDB…</div>;

  const cur = at(data.readings, t);
  // Heat exposure accumulated within this replay window up to the playhead (all stored readings, by observed time).
  let exp = 0;
  for (let i = 1; i < data.readings.length && data.readings[i].t <= t; i++) exp += excessDegMin(data.readings[i - 1], data.readings[i], data.rules.tempLowC, data.rules.tempHighC);
  const past = data.events.filter((e) => e.t <= t);
  const currentEvent = past[past.length - 1];
  const inc = data.incident;
  const outOfRange = cur && (cur.tc > data.rules.tempHighC || cur.tc < data.rules.tempLowC);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to={`/device/${inc.deviceId}`} className="btn btn-sm">
          <ArrowLeft size={14} aria-hidden /> {inc.deviceId}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          Replay · {INCIDENT_LABEL[inc.type]} <span className="text-ink-3">· {data.device?.name}</span>
        </h1>
        <span className="text-xs text-ink-3">
          Reconstructed from {data.readings.length} stored readings, {data.events.length} derived events and {data.commands.length} operator commands.
        </span>
      </div>

      <section className="panel p-3" aria-label="Replay controls">
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" onClick={() => (t >= data.to ? (setT(data.from), setPlaying(true)) : setPlaying((p) => !p))} aria-label={playing ? 'Pause replay' : 'Play replay'}>
            {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : t >= data.to ? 'Replay again' : 'Play'}
          </button>
          <button className="btn" onClick={() => setT(data.from)} aria-label="Back to start">
            <SkipBack size={14} />
          </button>
          <div className="flex gap-1" role="group" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button key={s} className={`btn btn-sm ${speed === s ? 'border-ice text-ice' : 'text-ink-3'}`} aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                {s}×
              </button>
            ))}
          </div>
          <span className="ml-auto text-2xl font-semibold tabular">{fmtTime(t)}</span>
        </div>
        <input
          type="range"
          className="mt-3 w-full accent-sky-400"
          min={data.from}
          max={data.to}
          step={1000}
          value={t}
          onChange={(e) => {
            setPlaying(false);
            setT(Number(e.target.value));
          }}
          aria-label="Replay position"
          aria-valuetext={fmtTime(t)}
        />
        <EventTicks events={data.events} from={data.from} to={data.to} onSeek={(x) => (setPlaying(false), setT(x))} />
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="panel min-w-0 p-3">
          <ReplayChart data={data} t={t} onSeek={(x) => (setPlaying(false), setT(x))} />
          {currentEvent && (
            <div className="mt-2 flex items-start gap-2 rounded-lg bg-panel-2 p-2.5 text-sm" aria-live="polite">
              <span className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SEV[currentEvent.severity] }} />
              <div>
                <b className="tabular">{fmtTime(currentEvent.t)}</b> · {currentEvent.title}
                {currentEvent.detail && <div className="line-clamp-2 text-xs text-ink-2">{currentEvent.detail}</div>}
              </div>
            </div>
          )}
        </section>

        <aside className="flex flex-col gap-4">
          <section className="panel p-3" aria-label="State at playhead">
            <div className="label">At {fmtTime(t)}</div>
            {cur ? (
              <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                <Cell Icon={Thermometer} label="Temperature" value={`${cur.tc.toFixed(2)} °C`} tone={outOfRange ? 'text-crit' : 'text-ok'} />
                <Cell Icon={Droplets} label="Humidity" value={`${cur.h.toFixed(0)} %RH`} />
                <Cell Icon={cur.door === 1 ? DoorOpen : DoorClosed} label="Door" value={cur.door === 1 ? 'OPEN' : cur.door === 0 ? 'closed' : '—'} tone={cur.door === 1 ? 'text-warn' : ''} />
                <Cell Icon={Fan} label="Cooling" value={COOLING_LABEL[cur.cs]} tone={cur.cs === 2 ? 'text-crit' : cur.cs === 3 ? 'text-warn' : ''} />
                <div className="col-span-2 rounded-md bg-panel-2 px-2.5 py-2">
                  <div className="label">Heat exposure in this window (demo)</div>
                  <BudgetBar used={exp} budget={data.rules.exposureBudgetCMin} />
                </div>
              </div>
            ) : (
              <p className="mt-2 text-xs text-ink-3">No reading yet at this time.</p>
            )}
            <RouteMini device={data.device} progress={cur?.p} status={outOfRange ? 'crit' : cur?.door === 1 || cur?.cs === 2 ? 'warn' : 'ok'} />
          </section>

          <section className="panel p-3" aria-label="Possible contributing factors">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Lightbulb size={15} className="text-warn" aria-hidden /> What the data suggests
            </h2>
            <div className="mt-2 flex flex-col gap-2">
              {data.factors.map((f) => (
                <div key={f.title} className="rounded-lg border border-warn/30 bg-warn-bg/30 p-2.5">
                  <div className="text-[13px] font-semibold">{f.title}</div>
                  <div className="mt-0.5 text-xs text-ink-2">{f.relation}</div>
                  <ul className="mt-1 list-disc pl-4 text-[11.5px] text-ink-2">
                    {f.evidence.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                  <div className="mt-1 flex gap-1 text-[10.5px] text-ink-3">
                    <Info size={11} className="mt-0.5 shrink-0" aria-hidden /> {f.caveat}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>

      <section className="panel p-3" aria-labelledby="story-h">
        <h2 id="story-h" className="text-sm font-semibold">
          How this happened
        </h2>
        <ol className="mt-2 grid gap-1.5 md:grid-cols-2">
          {data.events.map((e, i) => {
            const reached = e.t <= t;
            return (
              <li key={i}>
                <button
                  onClick={() => (setPlaying(false), setT(e.t))}
                  className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel-2 ${e === currentEvent ? 'bg-panel-2 ring-1 ring-ice/50' : ''} ${reached ? '' : 'opacity-45'}`}
                >
                  <span className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: SEV[e.severity] }} />
                  <span className="w-16 shrink-0 font-semibold tabular">{fmtTime(e.t).slice(0, 8)}</span>
                  <span className="min-w-0">
                    {e.title}
                    {e.detail && <span className="block truncate text-xs text-ink-3">{e.detail}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function Cell({ Icon, label, value, tone }: { Icon: typeof Fan; label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md bg-panel-2 px-2.5 py-2">
      <div className="label flex items-center gap-1">
        <Icon size={11} aria-hidden /> {label}
      </div>
      <div className={`mt-0.5 font-semibold tabular ${tone ?? ''}`}>{value}</div>
    </div>
  );
}

function EventTicks({ events, from, to, onSeek }: { events: StoryEvent[]; from: number; to: number; onSeek: (t: number) => void }) {
  return (
    <div className="relative mt-1 h-4" aria-hidden>
      {events.map((e, i) => (
        <button
          key={i}
          tabIndex={-1}
          title={`${fmtTime(e.t)} ${e.title}`}
          onClick={() => onSeek(e.t)}
          className="absolute top-0 h-3 w-1.5 -translate-x-1/2 rounded-sm"
          style={{ left: `${((e.t - from) / (to - from)) * 100}%`, background: SEV[e.severity] }}
        />
      ))}
    </div>
  );
}

function RouteMini({ device, progress, status }: { device?: DeviceInfo; progress?: number; status: 'ok' | 'warn' | 'crit' }) {
  if (!device) return null;
  const a = CITIES[device.origin];
  const b = CITIES[device.destination] ?? a;
  if (!a) return null;
  const p = device.kind === 'shipment' ? (progress ?? 0) : 0;
  const color = status === 'crit' ? '#ff5d5d' : status === 'warn' ? '#f0b429' : '#3ecf8e';
  return (
    <div className="mt-3">
      <div className="label">{device.kind === 'shipment' ? 'Truck position (simulated GPS)' : 'Cold room'}</div>
      <svg viewBox="0 0 300 54" className="mt-1 w-full" role="img" aria-label={`${device.origin} to ${device.destination}, ${Math.round(p * 100)} % of route`}>
        <line x1={20} y1={27} x2={280} y2={27} stroke="#2d3e4b" strokeWidth={4} strokeLinecap="round" />
        <line x1={20} y1={27} x2={20 + 260 * p} y2={27} stroke="#24506a" strokeWidth={4} strokeLinecap="round" />
        <text x={20} y={50} fontSize="10" fill="#7c8d9b">
          {device.origin}
        </text>
        <text x={280} y={50} fontSize="10" fill="#7c8d9b" textAnchor="end">
          {device.destination}
        </text>
        <g transform={`translate(${20 + 260 * p},27)`}>
          <rect x={-11} y={-8} width={22} height={13} rx={3} fill={color} />
          <circle cx={-6} cy={7} r={2.6} fill="#0b1116" />
          <circle cx={6} cy={7} r={2.6} fill="#0b1116" />
        </g>
      </svg>
    </div>
  );
}

function ReplayChart({ data, t, onSeek }: { data: ReplayData; t: number; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  const seekRef = useRef(onSeek);
  seekRef.current = onSeek;
  const cols = useMemo(() => {
    const rs = data.readings;
    return [rs.map((r) => r.t / 1000), rs.map((r) => r.tc), rs.map((r) => r.h)] as uPlot.AlignedData;
  }, [data]);

  useEffect(() => {
    const el = ref.current!;
    const R = data.rules;
    const doorSpans: [number, number][] = [];
    let open: number | null = null;
    for (const r of data.readings) {
      if (r.door === 1 && open == null) open = r.t / 1000;
      if (r.door !== 1 && open != null) {
        doorSpans.push([open, r.t / 1000]);
        open = null;
      }
    }
    if (open != null) doorSpans.push([open, data.to / 1000]);
    const u = new uPlot(
      {
        width: el.clientWidth || 600,
        height: 300,
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
        scales: { x: { time: true, range: [data.from / 1000, data.to / 1000] }, y: { range: (_u, mn, mx) => [Math.floor(Math.min(mn, R.tempLowC - 1)), Math.ceil(Math.max(mx, R.tempHighC + 1))] }, h: { range: [0, 100] } },
        axes: [
          { stroke: '#7c8d9b', font: '11px Inter, system-ui', grid: { stroke: '#1b2730' }, ticks: { stroke: '#1b2730' } },
          { stroke: '#7c8d9b', font: '11px Inter, system-ui', grid: { stroke: '#1b2730' }, ticks: { stroke: '#1b2730' }, label: 'Temperature (°C)', labelSize: 18, size: 46 },
          { scale: 'h', side: 1, stroke: '#7fd1b9', font: '11px Inter, system-ui', grid: { show: false }, label: 'Humidity %RH', labelSize: 18, size: 46 },
        ],
        series: [{}, { stroke: '#6cd3ff', width: 1.75, points: { show: false } }, { stroke: 'rgba(127,209,185,0.7)', width: 1, scale: 'h', points: { show: false } }],
        hooks: {
          draw: [
            (u) => {
              const c = u.ctx;
              const { left, top, width: w, height: h } = u.bbox;
              const dpr = devicePixelRatio;
              c.save();
              c.textAlign = 'left';
              // band
              const yHi = u.valToPos(R.tempHighC, 'y', true);
              const yLo = u.valToPos(R.tempLowC, 'y', true);
              c.fillStyle = 'rgba(62,207,142,0.06)';
              c.fillRect(left, yHi, w, yLo - yHi);
              c.setLineDash([5, 4]);
              c.strokeStyle = 'rgba(255,93,93,0.7)';
              for (const y of [yHi, yLo]) {
                c.beginPath();
                c.moveTo(left, y);
                c.lineTo(left + w, y);
                c.stroke();
              }
              c.setLineDash([]);
              // door spans
              c.fillStyle = 'rgba(240,180,41,0.85)';
              for (const [a, b] of doorSpans) {
                const x0 = u.valToPos(a, 'x', true);
                const x1 = u.valToPos(b, 'x', true);
                c.fillRect(x0, top + h - 6 * dpr, Math.max(2, x1 - x0), 6 * dpr);
              }
              // future shading + playhead
              const xp = u.valToPos(tRef.current / 1000, 'x', true);
              c.fillStyle = 'rgba(11,17,22,0.55)';
              c.fillRect(xp, top, left + w - xp, h);
              c.strokeStyle = '#ffffff';
              c.lineWidth = 2 * dpr;
              c.beginPath();
              c.moveTo(xp, top);
              c.lineTo(xp, top + h);
              c.stroke();
              c.restore();
            },
          ],
        },
      },
      cols,
      el,
    );
    plot.current = u;
    const onClick = (e: MouseEvent) => {
      const rect = u.over.getBoundingClientRect();
      seekRef.current(u.posToVal(e.clientX - rect.left, 'x') * 1000);
    };
    u.over.addEventListener('click', onClick);
    const ro = new ResizeObserver(() => el.clientWidth && u.setSize({ width: el.clientWidth, height: 300 }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.over.removeEventListener('click', onClick);
      u.destroy();
    };
  }, [data, cols]);

  useEffect(() => {
    plot.current?.redraw(false);
  }, [t]);

  return (
    <div>
      <div ref={ref} className="w-full" role="img" aria-label="Incident temperature and humidity with playhead; amber strip marks door open" />
      <div className="mt-1 flex flex-wrap gap-4 px-1 text-[11px] text-ink-3">
        <span>
          <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-[#6cd3ff]" />
          Temperature
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-[#7fd1b9]" />
          Humidity
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-warn" />
          Door open
        </span>
        <span>Click the chart to jump · dimmed area = not yet replayed</span>
      </div>
    </div>
  );
}
