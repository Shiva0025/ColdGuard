import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DoorClosed, DoorOpen, Fan, Radio, Snowflake, TriangleAlert, Unplug, Wrench, CheckCircle2, Truck } from 'lucide-react';
import {
  COMMAND_LABEL,
  INCIDENT_LABEL,
  SimLogger,
  ThermalModel,
  type DeviceInfo,
  type Incident,
  type SimCommandAck,
  type SimCommandMsg,
  type TelemetryBatchMsg,
  type TelemetryEventIn,
} from '@coldguard/shared';
import { realtime } from '../lib/realtime';

const KEY = 'coldguard.driver';

interface DriverSession {
  token: string;
  device: DeviceInfo;
  name: string;
  expiresAt: number;
}

function loadSession(): DriverSession | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as DriverSession | null;
    return s && s.expiresAt > Date.now() ? s : null;
  } catch {
    return null;
  }
}

/** Entry for audience members: /join/<code> → claim a truck → /drive. */
export function PhoneApp() {
  const [sess, setSess] = useState<DriverSession | null>(loadSession);
  const code = location.pathname.startsWith('/join/') ? decodeURIComponent(location.pathname.slice(6)) : '';
  if (sess) return <Drive sess={sess} onLeave={() => (sessionStorage.removeItem(KEY), setSess(null))} />;
  return (
    <Join
      code={code}
      onJoined={(s) => {
        try {
          sessionStorage.setItem(KEY, JSON.stringify(s));
        } catch {
          /* private mode: session lasts for this page only */
        }
        history.replaceState(null, '', '/drive');
        setSess(s);
      }}
    />
  );
}

function Join({ code, onJoined }: { code: string; onJoined: (s: DriverSession) => void }) {
  const [name, setName] = useState('');
  const [inv, setInv] = useState(code);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/guest/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: inv.trim(), name: name.trim() }) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
      onJoined({ token: b.token, device: b.device, name: name.trim(), expiresAt: b.expiresAt });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-5 py-10">
      <div className="flex items-center gap-2 text-ice">
        <Truck size={26} aria-hidden />
        <span className="text-xl font-bold text-ink">ColdGuard · drive a truck</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-ink-2">
        Your phone becomes a refrigerated truck. It runs a small thermal simulation and streams real telemetry to the ColdGuard server once a second.
        Open the door, break the compressor or drive into a tunnel — and watch the operator's screen react.
      </p>
      <form onSubmit={submit} className="panel mt-6 flex flex-col gap-3 p-5">
        <label className="flex flex-col gap-1">
          <span className="label">Your first name</span>
          <input className="input py-2.5 text-base" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} required autoFocus autoComplete="given-name" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Invite code</span>
          <input className="input py-2.5 text-base tabular" value={inv} onChange={(e) => setInv(e.target.value)} required autoCapitalize="none" />
        </label>
        {err && (
          <div role="alert" className="rounded-md bg-crit-bg px-3 py-2 text-sm text-crit">
            {err}
          </div>
        )}
        <button className="btn btn-primary justify-center py-3 text-base" disabled={busy}>
          {busy ? 'Assigning a truck…' : 'Start driving'}
        </button>
        <p className="text-[11px] text-ink-3">Simulated data only. Your name is shown on the operator dashboard for this session (2 h) and nothing else is collected.</p>
      </form>
    </div>
  );
}

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'warn' | 'crit';
}

function Drive({ sess, onLeave }: { sess: DriverSession; onLeave: () => void }) {
  const { device, token } = sess;
  const loggerRef = useRef<SimLogger | null>(null);
  if (!loggerRef.current) {
    const seed = Math.floor(Math.random() * 1e6);
    loggerRef.current = new SimLogger(new ThermalModel(device, seed, 0), `ph${Date.now().toString(36)}`);
  }
  const logger = loggerRef.current;
  const m = logger.model;
  const [, force] = useState(0);
  const [tunnel, setTunnel] = useState(false);
  const tunnelRef = useRef(false);
  tunnelRef.current = tunnel;
  const buffer = useRef<TelemetryEventIn[]>([]); // on-device store-and-forward
  const outbox = useRef<TelemetryEventIn[]>([]); // ready to upload
  const pendingCmds = useRef<SimCommandMsg[]>([]);
  const stats = useRef({ stored: 0, duplicates: 0, retries: 0, lastAckMs: 0, backoffUntil: 0, attempt: 0 });
  const [server, setServer] = useState<{ tc: number; t: number; lagMs: number; at: number } | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [conn, setConn] = useState(realtime.status);
  const sending = useRef(false);

  const toast = (text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [{ id, text, tone }, ...t].slice(0, 3));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  };

  // Apply an operator command on "the truck"; record the no-intervention projection first.
  const apply = (cmd: SimCommandMsg) => {
    const counterfactual = m.project(Date.now(), 900, 10);
    let reason: string | undefined;
    if (cmd.kind === 'close_door') {
      if (!m.s.doorOpen) reason = 'door already closed';
      m.closeDoor();
    } else if (cmd.kind === 'backup_cooling') {
      if (!m.s.compressorFailed) reason = 'primary cooling running; backup not engaged';
      else m.activateBackup();
    } else m.restorePrimary();
    realtime.send('command:ack', { id: cmd.id, deviceId: cmd.deviceId, phase: 'applied', appliedAt: Date.now(), counterfactual, horizonSec: 900, reason } satisfies SimCommandAck);
    toast(`Operator: ${COMMAND_LABEL[cmd.kind]} ✓`, 'ok');
    if (navigator.vibrate) navigator.vibrate(150);
    force((x) => x + 1);
  };

  // Socket: authenticated as this truck's driver; receives its own readings + commands.
  useEffect(() => {
    realtime.connect(token);
    const offStatus = realtime.on('status', setConn);
    void realtime.want('phone', { groups: [], devices: [device.id] });
    const offTel = realtime.on('telemetry', (msg: TelemetryBatchMsg) => {
      const last = msg.events.filter((e) => e.d === device.id).pop();
      if (last) setServer({ tc: last.tc, t: last.t, lagMs: Date.now() + realtime.clockOffset - last.r, at: Date.now() });
    });
    const offCmd = realtime.onRequest('command', (cmd: SimCommandMsg, ack?: (r: unknown) => void) => {
      if (cmd.deviceId !== device.id) return;
      const offline = tunnelRef.current;
      ack?.({ id: cmd.id, deviceId: cmd.deviceId, phase: 'delivered', queuedOffline: offline } satisfies SimCommandAck);
      if (offline) {
        pendingCmds.current.push(cmd);
        toast(`Command waiting for signal: ${COMMAND_LABEL[cmd.kind]}`, 'warn');
      } else setTimeout(() => apply(cmd), 300);
    });
    return () => {
      offStatus();
      offTel();
      offCmd();
      realtime.release('phone');
      realtime.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, device.id]);

  // 1 Hz: step the model, buffer or queue, upload with backoff.
  useEffect(() => {
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const ev = logger.step(Math.min(10, (now - last) / 1000), now);
      last = now;
      if (tunnelRef.current) {
        if (buffer.current.length < 1200) buffer.current.push(ev);
      } else outbox.current.push(ev);
      void upload();
      force((x) => x + 1);
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function upload() {
    if (sending.current || !outbox.current.length || tunnelRef.current) return;
    const st = stats.current;
    if (Date.now() < st.backoffUntil) return;
    sending.current = true;
    const batch = outbox.current.slice(0, 500);
    const t0 = performance.now();
    try {
      const r = await fetch('/api/ingest/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ events: batch }),
      });
      if (r.ok) {
        const b = await r.json();
        outbox.current.splice(0, batch.length);
        st.stored += b.persisted ?? 0;
        st.duplicates += b.duplicates ?? 0;
        st.lastAckMs = Math.round(performance.now() - t0);
        st.attempt = 0;
      } else if (r.status === 401) {
        onLeave();
      } else if (r.status === 400) {
        outbox.current.splice(0, batch.length); // non-retryable
      } else throw new Error(String(r.status));
    } catch {
      st.retries++;
      st.attempt = Math.min(st.attempt + 1, 6);
      st.backoffUntil = Date.now() + Math.min(8000, 250 * 2 ** st.attempt) * (0.5 + Math.random() * 0.5);
    } finally {
      sending.current = false;
    }
  }

  // Poll this truck's incidents (drivers are not in the fleet-wide alert rooms).
  useEffect(() => {
    let alive = true;
    const seen = new Set<string>();
    const load = async () => {
      try {
        const r = await fetch('/api/incidents?scope=all&limit=10', { headers: { authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const { incidents: list } = (await r.json()) as { incidents: Incident[] };
        if (!alive) return;
        for (const i of list) {
          if (i.active && !seen.has(i.id)) {
            seen.add(i.id);
            if (seen.size > 0) toast(`ColdGuard alert: ${INCIDENT_LABEL[i.type]}`, i.severity === 'critical' ? 'crit' : 'warn');
          }
        }
        setIncidents(list);
      } catch {
        /* offline */
      }
    };
    void load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function toggleTunnel() {
    if (!tunnel) {
      setTunnel(true);
      toast('No signal — your truck keeps measuring and stores readings', 'warn');
    } else {
      setTunnel(false);
      tunnelRef.current = false;
      const n = buffer.current.length;
      outbox.current.push(...buffer.current.splice(0));
      for (const c of pendingCmds.current.splice(0)) setTimeout(() => apply(c), 300);
      toast(`Signal back — uploading ${n} stored readings`, 'ok');
      void upload();
    }
  }

  const tc = m.s.temp;
  const out = tc > 8 || tc < 2;
  const active = incidents.filter((i) => i.active);
  const st = stats.current;
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-3 px-4 py-4">
      <header className="flex items-center gap-2">
        <Truck size={20} className="text-ice" aria-hidden />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate font-semibold">{device.name}</div>
          <div className="text-xs text-ink-3">
            {device.id} · {device.origin} → {device.destination}
          </div>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${tunnel ? 'bg-warn-bg text-warn' : conn === 'live' ? 'bg-ok-bg text-ok' : 'bg-off-bg text-off'}`}>
          {tunnel ? <Unplug size={12} /> : <Radio size={12} />} {tunnel ? 'No signal' : conn === 'live' ? 'Online' : 'Connecting'}
        </span>
      </header>

      <section className={`panel p-4 text-center ${out ? 'border-crit/60' : ''}`} aria-live="polite">
        <div className="label">Compartment temperature (your phone)</div>
        <div className={`mt-1 text-6xl font-bold tabular ${out ? 'text-crit' : 'text-ok'}`}>{tc.toFixed(1)}°</div>
        <div className="mt-1 text-xs text-ink-3">demo band 2–8 °C · humidity {m.s.hum.toFixed(0)} %RH</div>
        <div className="mt-2 text-xs text-ink-2">
          {server ? (
            <>
              Server confirmed <b className="tabular">{server.tc.toFixed(1)} °C</b>
              {Date.now() - server.at > 3000 ? (
                <span className="text-warn"> · {Math.round((Date.now() - server.at) / 1000)} s ago</span>
              ) : (
                <>
                  {' '}
                  · delivered in <b className="tabular">{Math.max(0, Math.round(server.lagMs))} ms</b>
                </>
              )}
            </>
          ) : tunnel ? (
            'Server cannot hear your truck right now'
          ) : (
            'Waiting for the server to confirm your first reading…'
          )}
        </div>
      </section>

      {active.length > 0 && (
        <section className="rounded-lg border border-crit/50 bg-crit-bg/60 p-3 text-sm" role="alert">
          <div className="flex items-center gap-1.5 font-semibold text-crit">
            <TriangleAlert size={15} /> ColdGuard raised {active.length === 1 ? 'an alert' : `${active.length} alerts`} on your truck
          </div>
          {active.slice(0, 2).map((i) => (
            <div key={i.id} className="mt-1 text-xs text-ink-2">
              <b>{INCIDENT_LABEL[i.type]}</b>
              {i.ack ? ` · acknowledged by ${i.ack.by}` : ' · operator notified'}
            </div>
          ))}
        </section>
      )}

      <section className="grid grid-cols-2 gap-2.5" aria-label="Truck controls">
        <BigButton
          on={m.s.doorOpen}
          onClick={() => (m.s.doorOpen ? m.closeDoor() : m.openDoor(), force((x) => x + 1))}
          Icon={m.s.doorOpen ? DoorOpen : DoorClosed}
          label={m.s.doorOpen ? 'Close door' : 'Open door'}
          sub={m.s.doorOpen ? 'Door is OPEN' : 'Door closed'}
        />
        <BigButton
          on={m.s.compressorFailed}
          onClick={() => (m.s.compressorFailed ? m.restorePrimary() : m.failCompressor(), force((x) => x + 1))}
          Icon={m.s.compressorFailed ? Wrench : Fan}
          label={m.s.compressorFailed ? 'Repair compressor' : 'Break compressor'}
          sub={m.s.cooling === 'backup' ? 'Backup cooling on' : m.s.compressorFailed ? 'Compressor FAULT' : `Cooling ${m.s.cooling}`}
        />
        <BigButton
          on={tunnel}
          onClick={toggleTunnel}
          Icon={tunnel ? Radio : Unplug}
          label={tunnel ? 'Exit tunnel' : 'Drive into tunnel'}
          sub={tunnel ? `${buffer.current.length} readings stored on truck` : 'Lose signal, keep measuring'}
          wide
        />
      </section>

      <section className="panel grid grid-cols-3 gap-2 p-3 text-center text-xs" aria-label="Upload statistics">
        <div>
          <div className="label">Stored on server</div>
          <div className="text-lg font-semibold tabular">{st.stored}</div>
        </div>
        <div>
          <div className="label">Waiting</div>
          <div className={`text-lg font-semibold tabular ${buffer.current.length + outbox.current.length > 1 ? 'text-warn' : ''}`}>{buffer.current.length + outbox.current.length}</div>
        </div>
        <div>
          <div className="label">Durable ack</div>
          <div className="text-lg font-semibold tabular">{st.lastAckMs ? `${st.lastAckMs} ms` : '—'}</div>
        </div>
      </section>

      <div className="pointer-events-none fixed inset-x-3 bottom-3 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`panel flex items-center gap-2 px-3 py-2.5 text-sm shadow-xl ${t.tone === 'crit' ? 'border-crit/60' : t.tone === 'warn' ? 'border-warn/60' : 'border-ok/60'}`}
          >
            {t.tone === 'ok' ? <CheckCircle2 size={16} className="text-ok" /> : t.tone === 'crit' ? <TriangleAlert size={16} className="text-crit" /> : <Snowflake size={16} className="text-warn" />}
            {t.text}
          </div>
        ))}
      </div>
      <button className="mt-2 self-center text-xs text-ink-3 underline" onClick={onLeave}>
        Leave truck
      </button>
    </div>
  );
}

function BigButton({ on, onClick, Icon, label, sub, wide }: { on: boolean; onClick: () => void; Icon: typeof Fan; label: string; sub: string; wide?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`flex flex-col items-center gap-1 rounded-xl border px-3 py-4 active:scale-[0.98] ${wide ? 'col-span-2' : ''} ${on ? 'border-warn/70 bg-warn-bg/60' : 'border-line-2 bg-panel-2'}`}
    >
      <Icon size={26} className={on ? 'text-warn' : 'text-ice'} aria-hidden />
      <span className="text-base font-semibold">{label}</span>
      <span className="text-[11px] text-ink-3">{sub}</span>
    </button>
  );
}
