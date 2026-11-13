import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AlertOctagon, BatteryLow, Copy, DoorOpen, FlaskConical, Play, RotateCcw, Shuffle, Square, ThermometerSun, Trash2, WifiOff } from 'lucide-react';
import { DEFAULT_RULES, type FaultRequest, type Rules, type SimulatorStatus } from '@coldguard/shared';
import { api } from '../lib/api';
import { fleet, platform, useStore } from '../lib/stores';
import { fmtInt, fmtMs } from '../lib/format';
import { SimTag } from '../components/bits';
import { JudgesPanel } from '../components/JudgesPanel';

interface SimInfo {
  desired: { running: boolean; deviceCount: number; intervalMs: number; seed: number };
  status: SimulatorStatus | null;
  faults: { at: number; by: string; fault: FaultRequest }[];
  resetAllowed: boolean;
}

const FAULTS: { kind: FaultRequest['kind']; label: string; desc: string; Icon: typeof Play; needsDevice: boolean; durationSec?: number }[] = [
  { kind: 'cooling_failure', label: 'Cooling failure', desc: 'Compressor stops; ≈3 °C/min rise → drift warning, then sustained excursion.', Icon: ThermometerSun, needsDevice: true },
  { kind: 'door_open', label: 'Door left open', desc: 'Compartment door opens: humidity jumps, warm air gets in; close it from the truck’s Response actions.', Icon: DoorOpen, needsDevice: true },
  { kind: 'sensor_dropout', label: 'Sensor dropout', desc: '25 s without uploads (store-and-forward) → offline incident, then backfill.', Icon: WifiOff, needsDevice: true, durationSec: 25 },
  { kind: 'low_battery', label: 'Low battery', desc: 'Battery falls below the configured threshold.', Icon: BatteryLow, needsDevice: true },
  { kind: 'duplicates', label: 'Duplicate delivery', desc: '20 s of ~30 % resent readings → rejected by the unique eventId index.', Icon: Copy, needsDevice: false, durationSec: 20 },
  { kind: 'out_of_order', label: 'Out-of-order', desc: '20 s with ~25 % of readings delayed 2–5 s → stored as late, state never regresses.', Icon: Shuffle, needsDevice: false, durationSec: 20 },
];

export function ControlPage() {
  useStore(fleet);
  useStore(platform);
  const [sim, setSim] = useState<SimInfo | null>(null);
  const [deviceId, setDeviceId] = useState('DC-S03');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [count, setCount] = useState(24);
  const [interval, setIntervalMs] = useState(1000);

  const refresh = async () => {
    const s = await api<SimInfo>('/sim');
    setSim(s);
    return s;
  };
  useEffect(() => {
    void refresh().then((s) => {
      setCount(s.desired.deviceCount);
      setIntervalMs(s.desired.intervalMs);
    });
    const t = setInterval(() => void refresh().catch(() => {}), 2000);
    return () => clearInterval(t);
  }, []);

  const say = (ok: boolean, text: string) => {
    setMsg({ ok, text });
    setTimeout(() => setMsg(null), 5000);
  };

  async function control(patch: Partial<SimInfo['desired']>) {
    try {
      await api('/sim/control', { method: 'POST', json: patch });
      await refresh();
      say(true, 'Simulator updated');
    } catch (e: any) {
      say(false, e.message);
    }
  }
  async function fault(kind: FaultRequest['kind'], withDevice: boolean, durationSec?: number) {
    try {
      await api('/sim/fault', { method: 'POST', json: { kind, ...(withDevice ? { deviceId } : {}), ...(durationSec ? { durationSec } : {}) } });
      say(true, `${kind.replace('_', ' ')} injected${withDevice ? ` on ${deviceId}` : ''}`);
      void refresh();
    } catch (e: any) {
      say(false, e.message);
    }
  }

  const st = platform.latest?.simulator ?? sim?.status ?? null;
  const evps = Math.round((count * 1000) / interval);
  const named = [...fleet.devices.values()].filter((d) => d.groupId !== 'stress');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Demo control centre</h1>
        <span className="text-xs text-ink-3">
          Operator-only. Controls drive the <b className="text-sim">simulated</b> fleet; the simulator is a separate process that still sends every reading through
          the real authenticated ingest API.
        </span>
      </div>
      {msg && (
        <div role="status" className={`rounded-md px-3 py-2 text-sm ${msg.ok ? 'bg-ok-bg text-ok' : 'bg-crit-bg text-crit'}`}>
          {msg.text}
        </div>
      )}

      <section className="panel p-4" aria-labelledby="guide-h">
        <h2 id="guide-h" className="text-sm font-semibold">
          Guided incident (≈2 minutes)
        </h2>
        <ol className="mt-2 grid gap-2 text-sm text-ink-2 md:grid-cols-4">
          <li className="rounded-md bg-panel-2 p-2.5">
            <b className="text-ink">1.</b> Open a second tab as <code>viewer.western</code> — it will never see Deccan events.
          </li>
          <li className="rounded-md bg-panel-2 p-2.5">
            <b className="text-ink">2.</b> Inject <b>Cooling failure</b> on {deviceId}. Within ~30 s: drift warning; ~75 s: critical excursion.
          </li>
          <li className="rounded-md bg-panel-2 p-2.5">
            <b className="text-ink">3.</b>{' '}
            <Link className="text-ice hover:underline" to={`/device/${deviceId}`}>
              Investigate {deviceId}
            </Link>
            : zoom into the breach, read the explanation, acknowledge.
          </li>
          <li className="rounded-md bg-panel-2 p-2.5">
            <b className="text-ink">4.</b> <b>Restore</b> the device; the incident resolves after the recovery window. Try <b>Drop connection</b> to see catch-up.
          </li>
        </ol>
      </section>

      <JudgesPanel />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel p-4" aria-labelledby="sim-h">
          <div className="flex items-center gap-2">
            <h2 id="sim-h" className="text-sm font-semibold">
              Simulator
            </h2>
            <SimTag />
            <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-semibold ${st?.connected ? 'bg-ok-bg text-ok' : 'bg-crit-bg text-crit'}`}>
              {st?.connected ? (st.running ? 'Connected · running' : 'Connected · stopped') : 'Not connected'}
            </span>
          </div>
          {!st?.connected && (
            <p className="mt-2 text-xs text-warn">
              Start it with <code>npm run start -w simulator</code> (or <code>npm run dev</code>, which runs everything).
            </p>
          )}
          <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="label">Sending</dt>
              <dd className="font-semibold tabular">{st ? `${fmtInt(st.sentPerSec)} ev/s` : '—'}</dd>
            </div>
            <div>
              <dt className="label">Backoff</dt>
              <dd className="font-semibold tabular">{st ? fmtMs(st.backoffMs) : '—'}</dd>
            </div>
            <div>
              <dt className="label">Retries</dt>
              <dd className="font-semibold tabular">{st ? fmtInt(st.retries) : '—'}</dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => control({ running: true })} disabled={sim?.desired.running}>
              <Play size={14} aria-hidden /> Start
            </button>
            <button className="btn" onClick={() => control({ running: false })} disabled={!sim?.desired.running}>
              <Square size={14} aria-hidden /> Stop
            </button>
          </div>
          <form
            className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void control({ deviceCount: count, intervalMs: interval });
            }}
          >
            <label className="flex flex-col gap-1 text-xs">
              <span className="label">Loggers: {count}</span>
              <input type="range" min={1} max={2000} step={1} value={count} onChange={(e) => setCount(+e.target.value)} aria-valuetext={`${count} loggers`} />
              <span className="text-ink-3">1–24 named fleet · 25–2000 adds stress loggers</span>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="label">Reading interval</span>
              <select className="input" value={interval} onChange={(e) => setIntervalMs(+e.target.value)}>
                {[2000, 1000, 500, 250, 100].map((v) => (
                  <option key={v} value={v}>
                    every {v} ms
                  </option>
                ))}
              </select>
              <span className={evps > 1500 ? 'text-warn' : 'text-ink-3'}>≈ {fmtInt(evps)} events/s offered{evps > 1500 ? ' · stress mode' : ''}</span>
            </label>
            <button className="btn">Apply</button>
          </form>
        </section>

        <section className="panel p-4" aria-labelledby="fault-h">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="fault-h" className="text-sm font-semibold">
              Fault injection
            </h2>
            <label className="ml-auto flex items-center gap-2 text-xs">
              <span className="text-ink-3">Target logger</span>
              <select className="input py-1" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                {named.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.id} · {d.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {FAULTS.map((f) => (
              <button key={f.kind} className="flex items-start gap-2.5 rounded-lg border border-line bg-panel-2 p-2.5 text-left hover:border-line-2" onClick={() => fault(f.kind, f.needsDevice, f.durationSec)}>
                <f.Icon size={18} className="mt-0.5 shrink-0 text-warn" aria-hidden />
                <span>
                  <span className="block text-sm font-semibold">
                    {f.label}
                    {f.needsDevice ? <span className="font-normal text-ink-3"> · {deviceId}</span> : <span className="font-normal text-ink-3"> · all loggers</span>}
                  </span>
                  <span className="block text-xs text-ink-3">{f.desc}</span>
                </span>
              </button>
            ))}
            <button className="flex items-start gap-2.5 rounded-lg border border-ok/40 bg-ok-bg/50 p-2.5 text-left hover:border-ok" onClick={() => fault('restore', true)}>
              <RotateCcw size={18} className="mt-0.5 shrink-0 text-ok" aria-hidden />
              <span>
                <span className="block text-sm font-semibold">Restore {deviceId}</span>
                <span className="block text-xs text-ink-3">Cooling back on (boosted) until the reading re-enters the band.</span>
              </span>
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            <button className="btn btn-sm" onClick={() => fault('restore', false)}>
              <RotateCcw size={13} aria-hidden /> Restore everything
            </button>
            {st?.activeFaults.length ? (
              <span className="self-center text-xs text-warn">Active: {st.activeFaults.map((f) => `${f.kind}${f.deviceId ? `@${f.deviceId}` : ''}`).join(', ')}</span>
            ) : (
              <span className="self-center text-xs text-ink-3">No active faults</span>
            )}
          </div>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RulesEditor />
        <ResetPanel allowed={!!sim?.resetAllowed} onDone={(t) => say(true, t)} onError={(t) => say(false, t)} />
      </div>
    </div>
  );
}

const RULE_FIELDS: { key: keyof Rules; label: string; unit: string; step: number }[] = [
  { key: 'tempLowC', label: 'Low limit', unit: '°C', step: 0.5 },
  { key: 'tempHighC', label: 'High limit', unit: '°C', step: 0.5 },
  { key: 'sustainSec', label: 'Sustained for', unit: 's', step: 5 },
  { key: 'hysteresisC', label: 'Hysteresis', unit: '°C', step: 0.1 },
  { key: 'recoverySec', label: 'Recovery time', unit: 's', step: 5 },
  { key: 'driftCPerMin', label: 'Drift slope', unit: '°C/min', step: 0.1 },
  { key: 'driftWindowSec', label: 'Drift window', unit: 's', step: 10 },
  { key: 'offlineSec', label: 'Offline after', unit: 's', step: 5 },
  { key: 'lowBatteryPct', label: 'Low battery', unit: '%', step: 1 },
  { key: 'exposureBudgetCMin', label: 'Heat budget', unit: '°C·min', step: 1 },
];

function RulesEditor() {
  const [r, setR] = useState<Rules>(fleet.rules ?? DEFAULT_RULES);
  const [state, setState] = useState<string | null>(null);
  useEffect(() => {
    void api<{ rules: Rules }>('/rules').then((x) => setR(x.rules));
  }, []);
  async function save() {
    try {
      const out = await api<{ rules: Rules }>('/rules', { method: 'PUT', json: r });
      fleet.setRules(out.rules);
      setState('Saved — applies to new readings immediately');
    } catch (e: any) {
      setState(e.message);
    }
  }
  return (
    <section className="panel p-4" aria-labelledby="rules-h">
      <h2 id="rules-h" className="text-sm font-semibold">
        Alert rules <span className="font-normal text-ink-3">· demonstration settings, not vaccine-storage guidance</span>
      </h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {RULE_FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-xs">
            <span className="label">
              {f.label} ({f.unit})
            </span>
            <input className="input tabular" type="number" step={f.step} value={r[f.key]} onChange={(e) => setR({ ...r, [f.key]: Number(e.target.value) })} />
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button className="btn btn-primary" onClick={save}>
          Save rules
        </button>
        <button className="btn" onClick={() => setR(DEFAULT_RULES)}>
          Defaults
        </button>
        {state && <span className="text-xs text-ink-2">{state}</span>}
      </div>
    </section>
  );
}

function ResetPanel({ allowed, onDone, onError }: { allowed: boolean; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [confirm, setConfirm] = useState('');
  return (
    <section className="panel border-crit/30 p-4" aria-labelledby="reset-h">
      <h2 id="reset-h" className="flex items-center gap-2 text-sm font-semibold">
        <AlertOctagon size={16} className="text-crit" aria-hidden /> Reset demo data
      </h2>
      <p className="mt-1 text-xs text-ink-3">
        Deletes all stored telemetry, incidents and device state. Users, devices and rules are kept. Requires <code>ALLOW_DEMO_RESET=true</code> on the
        server — keep it disabled on public deployments.
      </p>
      {allowed ? (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api('/demo/reset', { method: 'POST', json: { confirm } });
              setConfirm('');
              onDone('Demo data reset');
            } catch (err: any) {
              onError(err.message);
            }
          }}
        >
          <label className="text-xs text-ink-2">
            Type <b>RESET</b> to confirm{' '}
            <input className="input ml-1 w-28 py-1" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Type RESET to confirm" />
          </label>
          <button className="btn btn-danger" disabled={confirm !== 'RESET'}>
            <Trash2 size={14} aria-hidden /> Reset
          </button>
        </form>
      ) : (
        <p className="mt-3 text-xs text-warn">Disabled on this server.</p>
      )}
      <p className="mt-3 flex items-center gap-1 text-[11px] text-ink-3">
        <FlaskConical size={12} aria-hidden /> Load testing uses a separate script: <code>npm run loadtest -- --rate 1000 --clients 20</code>
      </p>
    </section>
  );
}
