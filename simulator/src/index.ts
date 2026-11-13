import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import {
  buildFleet,
  MAX_DEVICES,
  Rng,
  SimLogger,
  ThermalModel,
  type FaultRequest,
  type SimCommandAck,
  type SimCommandMsg,
  type SimDeviceNet,
  type SimulatorStatus,
  type TelemetryEventIn,
} from '@coldguard/shared';
import { IngestClient } from './client.js';

/**
 * ColdGuard simulator agent. A separate process that:
 *  - generates deterministic (seeded) readings for N loggers,
 *  - delivers them through the real authenticated ingest API (HTTP batches),
 *  - accepts control, fault and operator *command* messages from the server's
 *    `/agent` namespace (control plane only — readings never travel over it).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../.env'), quiet: true } as any);

const URL = process.env.COLDGUARD_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4000}`;
const KEY = process.env.AGENT_KEY;
if (!KEY) {
  console.error('[sim] AGENT_KEY is required');
  process.exit(1);
}

interface Control {
  running: boolean;
  deviceCount: number;
  intervalMs: number;
  seed: number;
}

/** Per-device network & command state (the "truck's" uplink). */
interface Uplink {
  offlineUntil: number; // 0 = online; Infinity = until a reconnect command
  buffer: TelemetryEventIn[]; // store-and-forward while offline
  outbox: number; // handed to the HTTP client, not yet durably acknowledged
  backfillTotal: number;
  backfillIds: Set<string>;
  backfillDelivered: number;
  duplicatesUntil: number;
  outOfOrderUntil: number;
  pendingCommands: SimCommandMsg[];
}

let control: Control = { running: false, deviceCount: 24, intervalMs: 1000, seed: 42 };
let loggers: SimLogger[] = [];
let byId = new Map<string, SimLogger>();
const uplinks = new Map<string, Uplink>();
const bootId = `b${Date.now().toString(36)}`;
const client = new IngestClient(URL, KEY);

const netFaults = { duplicatesUntil: 0, outOfOrderUntil: 0 };
const activeFaults: { kind: string; deviceId?: string; until?: number }[] = [];
let held: { ev: TelemetryEventIn; releaseAt: number }[] = [];
let lastBatch: TelemetryEventIn[] = [];
let netRnd = new Rng(1);

const uplink = (id: string): Uplink => {
  let u = uplinks.get(id);
  if (!u) {
    u = { offlineUntil: 0, buffer: [], outbox: 0, backfillTotal: 0, backfillIds: new Set(), backfillDelivered: 0, duplicatesUntil: 0, outOfOrderUntil: 0, pendingCommands: [] };
    uplinks.set(id, u);
  }
  return u;
};

client.onSettled = (batch) => {
  for (const ev of batch) {
    const u = uplinks.get(ev.deviceId);
    if (!u) continue;
    u.outbox = Math.max(0, u.outbox - 1);
    if (u.backfillIds.delete(ev.eventId)) u.backfillDelivered++;
  }
};

function send(evs: TelemetryEventIn[]) {
  if (!evs.length) return;
  for (const ev of evs) uplink(ev.deviceId).outbox++;
  client.push(evs);
}

function rebuild() {
  const fleet = buildFleet(Math.min(control.deviceCount, MAX_DEVICES));
  const old = byId;
  loggers = fleet.map((info, i) => old.get(info.id) ?? new SimLogger(new ThermalModel(info, control.seed, i), `${bootId}-${i.toString(36)}`));
  byId = new Map(loggers.map((d) => [d.model.info.id, d]));
  netRnd = new Rng(control.seed ^ 0x5bd1e995);
}

const target = (f: FaultRequest, fallback: number) => (f.deviceId ? byId.get(f.deviceId) : undefined) ?? loggers[fallback];

function applyFault(f: FaultRequest) {
  const now = Date.now();
  const until = f.durationSec ? now + f.durationSec * 1000 : undefined;
  switch (f.kind) {
    case 'cooling_failure': {
      const d = f.deviceId ? byId.get(f.deviceId) : byId.get('DC-S03');
      if (!d) return;
      d.model.failCompressor();
      activeFaults.push({ kind: f.kind, deviceId: d.model.info.id, until });
      if (until) setTimeout(() => restoreDevice(d.model.info.id), until - now);
      break;
    }
    case 'door_open': {
      const d = target(f, 2);
      d.model.openDoor();
      activeFaults.push({ kind: f.kind, deviceId: d.model.info.id, until });
      if (until) setTimeout(() => d.model.closeDoor(), until - now);
      break;
    }
    case 'sensor_dropout': {
      const d = target(f, 1);
      const u = uplink(d.model.info.id);
      // No duration ⇒ offline until an explicit `reconnect`.
      u.offlineUntil = f.durationSec ? now + f.durationSec * 1000 : Infinity;
      activeFaults.push({ kind: f.kind, deviceId: d.model.info.id, until: f.durationSec ? u.offlineUntil : undefined });
      break;
    }
    case 'reconnect': {
      const d = target(f, 1);
      uplink(d.model.info.id).offlineUntil = now; // takes effect on the next tick
      break;
    }
    case 'low_battery': {
      const d = target(f, 2);
      d.model.s.battery = Math.min(d.model.s.battery, 16);
      d.model.s.batteryDrain = 0.02;
      activeFaults.push({ kind: f.kind, deviceId: d.model.info.id, until });
      break;
    }
    case 'duplicates':
      if (f.deviceId) uplink(f.deviceId).duplicatesUntil = now + (f.durationSec ?? 20) * 1000;
      else netFaults.duplicatesUntil = now + (f.durationSec ?? 20) * 1000;
      activeFaults.push({ kind: f.kind, deviceId: f.deviceId, until: now + (f.durationSec ?? 20) * 1000 });
      break;
    case 'out_of_order':
      if (f.deviceId) uplink(f.deviceId).outOfOrderUntil = now + (f.durationSec ?? 20) * 1000;
      else netFaults.outOfOrderUntil = now + (f.durationSec ?? 20) * 1000;
      activeFaults.push({ kind: f.kind, deviceId: f.deviceId, until: now + (f.durationSec ?? 20) * 1000 });
      break;
    case 'restore':
      if (f.deviceId) restoreDevice(f.deviceId);
      else {
        for (const d of loggers) d.model.repairAll();
        for (const u of uplinks.values()) {
          if (u.offlineUntil) u.offlineUntil = now;
          u.duplicatesUntil = u.outOfOrderUntil = 0;
        }
        netFaults.duplicatesUntil = netFaults.outOfOrderUntil = 0;
        activeFaults.length = 0;
      }
      break;
  }
  console.log(`[sim] fault ${f.kind}${f.deviceId ? ` on ${f.deviceId}` : ''}`);
}

function restoreDevice(id: string) {
  byId.get(id)?.model.repairAll();
  const u = uplinks.get(id);
  if (u?.offlineUntil) u.offlineUntil = Date.now();
  for (let i = activeFaults.length - 1; i >= 0; i--) if (activeFaults[i].deviceId === id) activeFaults.splice(i, 1);
}

// ---- Operator commands ------------------------------------------------------

const HORIZON_SEC = 900;

/** Apply a command on the "device": record the no-intervention counterfactual first. */
function applyCommand(cmd: SimCommandMsg) {
  const d = byId.get(cmd.deviceId);
  if (!d) {
    sock.emit('command:ack', { id: cmd.id, deviceId: cmd.deviceId, phase: 'failed', reason: 'unknown device' } satisfies SimCommandAck);
    return;
  }
  const now = Date.now();
  const counterfactual = d.model.project(now, HORIZON_SEC, 10);
  const m = d.model;
  let reason: string | undefined;
  if (cmd.kind === 'close_door') {
    if (!m.s.doorOpen) reason = 'door already closed';
    m.closeDoor();
  } else if (cmd.kind === 'backup_cooling') {
    if (!m.s.compressorFailed) reason = 'primary cooling is running; backup not engaged';
    else m.activateBackup();
  } else if (cmd.kind === 'restore_cooling') {
    m.restorePrimary();
  }
  for (let i = activeFaults.length - 1; i >= 0; i--) {
    const f = activeFaults[i];
    if (f.deviceId !== cmd.deviceId) continue;
    if ((cmd.kind === 'close_door' && f.kind === 'door_open') || (cmd.kind === 'restore_cooling' && f.kind === 'cooling_failure')) activeFaults.splice(i, 1);
  }
  sock.emit('command:ack', {
    id: cmd.id,
    deviceId: cmd.deviceId,
    phase: 'applied',
    appliedAt: now,
    counterfactual,
    horizonSec: HORIZON_SEC,
    reason,
  } satisfies SimCommandAck);
  console.log(`[sim] command ${cmd.kind} applied on ${cmd.deviceId}`);
}

// ---- Tick -------------------------------------------------------------------

let lastTick = Date.now();
let sentWindow: { at: number; n: number }[] = [];

function tick() {
  const now = Date.now();
  const dt = Math.min(10, (now - lastTick) / 1000);
  lastTick = now;
  if (!control.running) return;

  const out: TelemetryEventIn[] = [];
  for (const d of loggers) {
    const id = d.model.info.id;
    const ev = d.step(dt, now);
    const u = uplinks.get(id);
    if (u && u.offlineUntil && u.offlineUntil > now) {
      // Store-and-forward: the logger keeps measuring but cannot upload.
      if (u.buffer.length < 3600) u.buffer.push(ev);
      continue;
    }
    if (u && u.offlineUntil) {
      // Connectivity is back: deliver queued commands, then the buffered burst.
      u.offlineUntil = 0;
      for (const c of u.pendingCommands.splice(0)) applyCommand(c);
      if (u.buffer.length) {
        u.backfillTotal = u.buffer.length;
        u.backfillDelivered = 0;
        u.backfillIds = new Set(u.buffer.map((e) => e.eventId));
        out.push(...u.buffer);
        u.buffer = [];
      }
      for (let i = activeFaults.length - 1; i >= 0; i--) if (activeFaults[i].kind === 'sensor_dropout' && activeFaults[i].deviceId === id) activeFaults.splice(i, 1);
    }
    out.push(ev);
  }

  // Out-of-order delivery: hold back ~25 % of readings (fleet-wide or per device) for 2–5 s.
  let toSend: TelemetryEventIn[] = [];
  for (const ev of out) {
    const u = uplinks.get(ev.deviceId);
    const ooo = netFaults.outOfOrderUntil > now || (u?.outOfOrderUntil ?? 0) > now;
    if (ooo && netRnd.next() < 0.25) held.push({ ev, releaseAt: now + 2000 + netRnd.next() * 3000 });
    else toSend.push(ev);
  }
  const release = held.filter((h) => h.releaseAt <= now);
  held = held.filter((h) => h.releaseAt > now);
  toSend.push(...release.map((h) => h.ev));

  // Duplicate delivery: resend ~30 % of the previous tick's readings.
  for (const ev of lastBatch) {
    const u = uplinks.get(ev.deviceId);
    const dup = netFaults.duplicatesUntil > now || (u?.duplicatesUntil ?? 0) > now;
    const p = (u?.duplicatesUntil ?? 0) > now ? 0.6 : 0.3;
    if (dup && netRnd.next() < p) toSend.push(ev);
  }
  lastBatch = out;

  for (let i = activeFaults.length - 1; i >= 0; i--) if (activeFaults[i].until && activeFaults[i].until! < now) activeFaults.splice(i, 1);

  send(toSend);
  sentWindow.push({ at: now, n: toSend.length });
}

let timer: NodeJS.Timeout | null = null;
function schedule() {
  if (timer) clearInterval(timer);
  lastTick = Date.now();
  timer = setInterval(tick, control.intervalMs);
}

const sock = io(`${URL}/agent`, { auth: { key: KEY }, reconnectionDelayMax: 5000 });
sock.on('connect', () => console.log(`[sim] connected to ${URL}/agent`));
sock.on('connect_error', (e) => console.warn(`[sim] control channel: ${e.message}`));
sock.on('control', (c: Control) => {
  const changedShape = c.deviceCount !== control.deviceCount || c.seed !== control.seed || loggers.length === 0;
  const changedRate = c.intervalMs !== control.intervalMs || !timer;
  control = { ...c };
  if (changedShape) rebuild();
  if (changedRate) schedule();
  console.log(`[sim] control: ${control.running ? 'running' : 'stopped'}, ${control.deviceCount} devices @ ${control.intervalMs} ms (≈${Math.round((control.deviceCount * 1000) / control.intervalMs)} ev/s), seed ${control.seed}`);
});
sock.on('fault', (f: FaultRequest) => applyFault(f));
sock.on('command', (cmd: SimCommandMsg, ack?: (a: SimCommandAck) => void) => {
  const known = byId.has(cmd.deviceId);
  const u = uplinks.get(cmd.deviceId);
  const offline = !!u && !!u.offlineUntil && u.offlineUntil > Date.now();
  if (typeof ack === 'function') ack({ id: cmd.id, deviceId: cmd.deviceId, phase: known ? 'delivered' : 'failed', queuedOffline: offline, reason: known ? undefined : 'unknown device' });
  if (!known) return;
  if (offline) {
    // The truck has no signal: the command waits on the uplink until it reconnects.
    u!.pendingCommands.push(cmd);
    console.log(`[sim] command ${cmd.kind} queued for offline ${cmd.deviceId}`);
  } else setTimeout(() => applyCommand(cmd), 300 + Math.round(netRnd.next() * 500)); // small radio latency
});

setInterval(() => {
  const now = Date.now();
  sentWindow = sentWindow.filter((w) => now - w.at < 5000);
  const devices: Record<string, SimDeviceNet> = {};
  for (const [id, u] of uplinks) {
    const offline = !!u.offlineUntil && u.offlineUntil > now;
    const heldN = held.filter((h) => h.ev.deviceId === id).length;
    const faults = activeFaults.filter((f) => f.deviceId === id).map((f) => f.kind);
    if (!offline && !u.buffer.length && !u.outbox && !heldN && !u.pendingCommands.length && !faults.length && !u.backfillTotal && u.duplicatesUntil < now && u.outOfOrderUntil < now) continue;
    devices[id] = {
      offline,
      buffered: u.buffer.length,
      outbox: u.outbox,
      heldOutOfOrder: heldN,
      backfillTotal: u.backfillTotal,
      backfillDelivered: u.backfillDelivered,
      pendingCommands: u.pendingCommands.length,
      faults: [...faults, ...(u.duplicatesUntil > now ? ['duplicates'] : []), ...(u.outOfOrderUntil > now ? ['out_of_order'] : [])],
    };
  }
  const status: SimulatorStatus = {
    connected: true,
    running: control.running,
    deviceCount: control.deviceCount,
    intervalMs: control.intervalMs,
    seed: control.seed,
    sentPerSec: Math.round(sentWindow.reduce((a, w) => a + w.n, 0) / 5),
    backoffMs: client.pending > 0 ? client.backoffMs : 0,
    retries: client.stats.retries,
    activeFaults: [...activeFaults],
    lastSeenAt: now,
    devices,
  };
  if (sock.connected) sock.emit('status', status);
}, 1000);

rebuild();
schedule();
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
