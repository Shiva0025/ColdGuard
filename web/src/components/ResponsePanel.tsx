import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import { Check, DoorClosed, Fan, Snowflake, Loader2, XCircle, CloudOff } from 'lucide-react';
import { COMMAND_LABEL, excessDegMin, type Command, type DeviceState, type Incident, type Reading, type Rules } from '@coldguard/shared';
import { api } from '../lib/api';
import { realtime } from '../lib/realtime';
import { fmtTime } from '../lib/format';
import { SimTag } from './bits';

const STEPS: { key: Command['state']; label: string }[] = [
  { key: 'requested', label: 'Requested' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'acknowledged', label: 'Applied' },
  { key: 'effect_observed', label: 'Confirmed' },
];
const ORDER = { requested: 0, delivered: 1, acknowledged: 2, effect_observed: 3, failed: -1 } as const;

/** Commands for one device: initial REST load + live `command` events. */
export function useCommands(deviceId: string) {
  const [list, setList] = useState<Command[]>([]);
  useEffect(() => {
    let alive = true;
    api<{ commands: Command[] }>(`/devices/${encodeURIComponent(deviceId)}/commands`)
      .then((r) => alive && setList(r.commands))
      .catch(() => {});
    const off = realtime.on('command', (c) => {
      if (c.deviceId !== deviceId) return;
      setList((cur) => [c, ...cur.filter((x) => x.id !== c.id)].sort((a, b) => b.requestedAt - a.requestedAt));
    });
    return () => {
      alive = false;
      off();
    };
  }, [deviceId]);
  return [list, setList] as const;
}

export function ResponsePanel({
  deviceId,
  state,
  canAct,
  incident,
  readings,
  rules,
  version,
}: {
  deviceId: string;
  state?: DeviceState;
  canAct: boolean;
  incident?: Incident;
  readings: Reading[];
  rules: Rules | null;
  version: number;
}) {
  const [cmds, setCmds] = useCommands(deviceId);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function issue(kind: Command['kind']) {
    setBusy(kind);
    setErr(null);
    try {
      const r = await api<{ command: Command }>(`/devices/${encodeURIComponent(deviceId)}/commands`, {
        method: 'POST',
        json: { kind, ...(incident ? { incidentId: incident.id } : {}) },
      });
      setCmds((cur) => [r.command, ...cur.filter((x) => x.id !== r.command.id)]);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  const doorOpen = state?.door === 1;
  const fault = state?.cs === 2;
  const actions: { kind: Command['kind']; Icon: typeof Fan; hint: string; recommended: boolean }[] = [
    { kind: 'close_door', Icon: DoorClosed, hint: doorOpen ? 'Door sensor reports OPEN' : 'Door currently closed', recommended: doorOpen },
    { kind: 'backup_cooling', Icon: Snowflake, hint: fault ? 'Primary compressor reports FAULT' : 'Only engages if the compressor has failed', recommended: fault },
    { kind: 'restore_cooling', Icon: Fan, hint: 'Remote reset of the primary compressor', recommended: fault },
  ];
  const withCf = cmds.find((c) => c.counterfactual && (c.state === 'acknowledged' || c.state === 'effect_observed'));

  return (
    <section className="panel p-3" aria-labelledby="resp-h">
      <div className="flex items-center gap-2 px-1">
        <h2 id="resp-h" className="text-sm font-semibold">
          Response actions
        </h2>
        <SimTag title="Commands drive simulated actuators" />
      </div>
      {canAct ? (
        <div className="mt-2 grid gap-2">
          {actions.map((a) => (
            <button
              key={a.kind}
              disabled={!!busy}
              onClick={() => issue(a.kind)}
              className={`flex items-center gap-2.5 rounded-lg border p-2 text-left ${a.recommended ? 'border-ice/70 bg-ice-dim/25' : 'border-line bg-panel-2 hover:border-line-2'}`}
            >
              {busy === a.kind ? <Loader2 size={17} className="animate-spin text-ice" /> : <a.Icon size={17} className="text-ice" aria-hidden />}
              <span className="min-w-0">
                <span className="block text-sm font-semibold">
                  {COMMAND_LABEL[a.kind]} {a.recommended && <span className="ml-1 rounded bg-ice/20 px-1 text-[10px] text-ice">suggested by current readings</span>}
                </span>
                <span className="block text-[11px] text-ink-3">{a.hint}</span>
              </span>
            </button>
          ))}
          {err && <span className="text-xs text-crit">{err}</span>}
        </div>
      ) : (
        <p className="mt-2 px-1 text-xs text-ink-3">Operators can send commands; you can follow their progress here.</p>
      )}
      <ol className="mt-3 flex flex-col gap-2" aria-label="Command history">
        {cmds.slice(0, 4).map((c) => (
          <CommandRow key={c.id} c={c} />
        ))}
      </ol>
      {withCf && rules && <Comparison cmd={withCf} readings={readings} rules={rules} version={version} />}
    </section>
  );
}

function CommandRow({ c }: { c: Command }) {
  const reached = ORDER[c.state];
  const at = (k: Command['state']) =>
    k === 'requested' ? c.requestedAt : k === 'delivered' ? c.deliveredAt : k === 'acknowledged' ? c.acknowledgedAt : c.effectAt;
  return (
    <li className="rounded-lg border border-line bg-panel-2/60 p-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
        {COMMAND_LABEL[c.kind]}
        <span className="text-[11px] font-normal text-ink-3">by {c.requestedBy}</span>
        {c.queuedOffline && c.state === 'delivered' && (
          <span className="inline-flex items-center gap-1 rounded bg-warn-bg px-1.5 text-[11px] text-warn">
            <CloudOff size={11} /> queued — truck offline
          </span>
        )}
      </div>
      {c.state === 'failed' ? (
        <div className="mt-1 flex items-center gap-1 text-xs text-crit">
          <XCircle size={13} /> Failed: {c.failure}
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-4 gap-1" role="list" aria-label="Lifecycle">
          {STEPS.map((s, i) => {
            const done = reached >= i;
            const current = reached === i - 1;
            return (
              <div key={s.key} role="listitem" className="min-w-0">
                <div className={`h-1.5 rounded-full ${done ? (i === 3 ? 'bg-ok' : 'bg-ice') : current ? 'animate-pulse bg-line-2' : 'bg-line'}`} />
                <div className={`mt-1 flex items-center gap-0.5 truncate text-[10.5px] ${done ? 'text-ink' : 'text-ink-3'}`}>
                  {done && <Check size={10} aria-hidden />}
                  {s.label}
                </div>
                <div className="text-[10px] text-ink-3 tabular">{done ? fmtTime(at(s.key)) : current ? 'waiting…' : ''}</div>
              </div>
            );
          })}
        </div>
      )}
      {c.effect && <div className="mt-1.5 text-[11.5px] text-ok">✓ {c.effect.text}</div>}
    </li>
  );
}

function exposure(points: [number, number][], low: number, high: number) {
  let e = 0;
  for (let i = 1; i < points.length; i++) e += excessDegMin({ t: points[i - 1][0], tc: points[i - 1][1] }, { t: points[i][0], tc: points[i][1] }, low, high);
  return e;
}

function minutesOutside(points: [number, number][], low: number, high: number) {
  let ms = 0;
  let peak = -Infinity;
  for (let i = 1; i < points.length; i++) {
    const [t0, v0] = points[i - 1];
    const [t1] = points[i];
    if (v0 > high || v0 < low) ms += t1 - t0;
    peak = Math.max(peak, points[i][1]);
  }
  return { min: ms / 60000, peak: points.length ? Math.max(peak, points[0][1]) : NaN };
}

/** Simulated comparison: the projection without the command vs. what telemetry shows with it. */
function Comparison({ cmd, readings, rules, version }: { cmd: Command; readings: Reading[]; rules: Rules; version: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const cf = cmd.counterfactual!;
  const start = cmd.acknowledgedAt ?? cmd.requestedAt;
  const end = start + cf.horizonSec * 1000;
  const observed = useMemo<[number, number][]>(
    () => readings.filter((r) => r.t >= start && r.t <= end && !r.late).map((r) => [r.t, r.tc]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readings, version, start, end],
  );
  const proj = minutesOutside(cf.points, rules.tempLowC, rules.tempHighC);
  const obs = minutesOutside(observed, rules.tempLowC, rules.tempHighC);
  const observedSpanMin = observed.length > 1 ? (observed[observed.length - 1][0] - observed[0][0]) / 60000 : 0;
  // Projection over the same elapsed window as observed so far, for a like-for-like comparison.
  const projSoFar = minutesOutside(
    cf.points.filter(([t]) => t <= start + observedSpanMin * 60000 + 10000),
    rules.tempLowC,
    rules.tempHighC,
  );

  useEffect(() => {
    const el = ref.current!;
    plot.current = new uPlot(
      {
        width: el.clientWidth || 320,
        height: 150,
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
        scales: { x: { time: true }, y: { range: (_u, mn, mx) => [Math.floor(Math.min(mn ?? 2, rules.tempLowC - 1)), Math.ceil(Math.max(mx ?? 8, rules.tempHighC + 1))] } },
        axes: [
          { stroke: '#7c8d9b', font: '10px Inter, system-ui', grid: { stroke: '#1b2730' }, ticks: { stroke: '#1b2730' } },
          { stroke: '#7c8d9b', font: '10px Inter, system-ui', grid: { stroke: '#1b2730' }, ticks: { stroke: '#1b2730' }, size: 34 },
        ],
        series: [
          {},
          { label: 'Simulated: no intervention', stroke: '#c4a7ff', width: 1.5, dash: [5, 4], spanGaps: true, points: { show: false } },
          { label: 'Observed: with intervention', stroke: '#3ecf8e', width: 1.75, spanGaps: true, points: { show: false } },
        ],
        hooks: {
          draw: [
            (u) => {
              const c = u.ctx;
              const y = u.valToPos(rules.tempHighC, 'y', true);
              c.save();
              c.setLineDash([4, 4]);
              c.strokeStyle = 'rgba(255,93,93,0.7)';
              c.beginPath();
              c.moveTo(u.bbox.left, y);
              c.lineTo(u.bbox.left + u.bbox.width, y);
              c.stroke();
              c.restore();
            },
          ],
        },
      },
      [[], [], []],
      el,
    );
    const ro = new ResizeObserver(() => el.clientWidth && plot.current?.setSize({ width: el.clientWidth, height: 150 }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
  }, [rules.tempHighC, rules.tempLowC]);

  useEffect(() => {
    const xs = [...new Set([...cf.points.map((p) => p[0]), ...observed.map((p) => p[0])])].sort((a, b) => a - b);
    const a = new Map(cf.points);
    const b = new Map(observed);
    plot.current?.setData([xs.map((x) => x / 1000), xs.map((x) => a.get(x) ?? null), xs.map((x) => b.get(x) ?? null)] as uPlot.AlignedData);
  }, [cf.points, observed]);

  return (
    <div className="mt-3 rounded-lg border border-sim/30 bg-panel-2/40 p-2.5">
      <div className="flex items-center gap-2 text-[12.5px] font-semibold">
        Simulated comparison: {COMMAND_LABEL[cmd.kind].toLowerCase()} <SimTag />
      </div>
      <div ref={ref} className="mt-1 w-full" role="img" aria-label="Projected temperature without intervention versus observed temperature with intervention" />
      <div className="mt-1 grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded bg-bg/60 p-1.5">
          <div className="flex items-center gap-1 font-semibold text-sim">
            <span className="inline-block h-0.5 w-3 border-t-2 border-dashed border-sim" /> Without intervention
          </div>
          <div className="text-ink-2">
            {projSoFar.min.toFixed(1)} min outside range so far · {proj.min.toFixed(1)} min over {cf.horizonSec / 60} min
          </div>
          <div className="text-ink-3">peak {proj.peak.toFixed(1)} °C (projection)</div>
          <div className="text-ink-2">heat budget +{exposure(cf.points, rules.tempLowC, rules.tempHighC).toFixed(1)} °C·min</div>
        </div>
        <div className="rounded bg-bg/60 p-1.5">
          <div className="flex items-center gap-1 font-semibold text-ok">
            <span className="inline-block h-0.5 w-3 bg-ok" /> With intervention
          </div>
          <div className="text-ink-2">
            {obs.min.toFixed(1)} min outside range in {observedSpanMin.toFixed(1)} min observed
          </div>
          <div className="text-ink-3">peak {Number.isFinite(obs.peak) ? `${obs.peak.toFixed(1)} °C` : '—'} (telemetry)</div>
          <div className="text-ink-2">heat budget +{exposure(observed, rules.tempLowC, rules.tempHighC).toFixed(1)} °C·min</div>
        </div>
      </div>
      <p className="mt-1.5 text-[10.5px] leading-snug text-ink-3">
        The dashed line is the same simulated thermal model cloned when the truck applied the command and continued without it. It is a
        what-if inside the simulation — not a real-world forecast and not proof of stock saved.
      </p>
    </div>
  );
}
