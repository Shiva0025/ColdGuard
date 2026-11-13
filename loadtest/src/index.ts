import { config } from 'dotenv';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { io, type Socket } from 'socket.io-client';
import type { PlatformMetrics, TelemetryBatchMsg, TelemetryEventIn, FleetDeltaMsg } from '@coldguard/shared';
import { IngestClient } from '../../simulator/src/client.js';

/**
 * ColdGuard load test.
 *
 * Offers a configurable event rate through the real ingest API (same client,
 * backoff and idempotent retries as the simulator) while N Socket.IO clients
 * subscribe to device rooms + the stress group. Everything runs on one
 * machine, so server receivedAt → client receipt latency uses one clock.
 *
 * Usage: npm run loadtest -- --rate 1000 --clients 20 --duration 60
 */
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../.env'), quiet: true } as any);

const { values: a } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.COLDGUARD_URL ?? 'http://127.0.0.1:4000' },
    rate: { type: 'string', default: '500' },
    devices: { type: 'string', default: '' },
    clients: { type: 'string', default: '10' },
    'devices-per-client': { type: 'string', default: '5' },
    duration: { type: 'string', default: '60' },
    warmup: { type: 'string', default: '10' },
    batch: { type: 'string', default: '250' },
    concurrency: { type: 'string', default: '4' },
    'burst-rate': { type: 'string', default: '0' },
    'burst-sec': { type: 'string', default: '15' },
    recovery: { type: 'string', default: '15' },
    password: { type: 'string', default: process.env.DEMO_PASSWORD ?? 'coldguard-demo' },
    label: { type: 'string', default: '' },
    'keep-sim': { type: 'boolean', default: false },
  },
});

const URL = a.url!;
const RATE = +a.rate!;
const DEVICES = Math.min(1976, +(a.devices || Math.min(1976, Math.max(50, RATE))));
const CLIENTS = +a.clients!;
const PER_CLIENT = +a['devices-per-client']!;
const DURATION = +a.duration!;
const WARMUP = +a.warmup!;
const BURST_RATE = +a['burst-rate']!;
const BURST_SEC = +a['burst-sec']!;
const RECOVERY = +a.recovery!;
const KEY = process.env.AGENT_KEY!;
if (!KEY) throw new Error('AGENT_KEY missing (.env)');

const deviceIds = Array.from({ length: DEVICES }, (_, i) => `ST-${String(i + 1).padStart(4, '0')}`);
const session = `lt${Date.now().toString(36)}`;

async function login(): Promise<string> {
  const r = await fetch(`${URL}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'operator', password: a.password }) });
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  return (await r.json()).token;
}
const getJson = async <T>(p: string, tok: string): Promise<T> => (await fetch(`${URL}/api${p}`, { headers: { authorization: `Bearer ${tok}` } })).json() as Promise<T>;
const postJson = (p: string, tok: string, body: unknown) =>
  fetch(`${URL}/api${p}`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

function pct(arr: number[], p: number) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
}

interface ClientStat {
  sock: Socket;
  devices: string[];
  ids: Map<string, Set<string>>;
  latency: number[];
  fleetMsgs: number;
  fleetStates: number;
  telemetryMsgs: number;
  bytes: number;
}

async function main() {
  const tok = await login();
  let simWas: any = null;
  if (!a['keep-sim']) {
    simWas = (await getJson<any>('/sim', tok)).desired;
    await postJson('/sim/control', tok, { running: false });
  }
  console.log(`[lt] ${RATE} ev/s offered over ${DEVICES} loggers, ${CLIENTS} socket clients × ${PER_CLIENT} device rooms + stress group; warm-up ${WARMUP}s, measure ${DURATION}s${BURST_RATE ? `, burst ${BURST_RATE} ev/s for ${BURST_SEC}s` : ''}, recovery ${RECOVERY}s`);

  // ---- Socket clients ----
  const clients: ClientStat[] = [];
  let measuring = false;
  let startCursor = 0; // commit watermark before any load-test event was offered
  for (let i = 0; i < CLIENTS; i++) {
    const devs = Array.from({ length: PER_CLIENT }, (_, k) => deviceIds[(i * PER_CLIENT + k) % DEVICES]);
    const sock = io(URL, { auth: { token: tok }, transports: ['websocket'], forceNew: true });
    const st: ClientStat = { sock, devices: devs, ids: new Map(devs.map((d) => [d, new Set()])), latency: [], fleetMsgs: 0, fleetStates: 0, telemetryMsgs: 0, bytes: 0 };
    sock.on('telemetry', (m: TelemetryBatchMsg) => {
      const now = Date.now();
      st.telemetryMsgs++;
      for (const e of m.events) {
        st.ids.get(e.d)?.add(e.id);
        if (measuring) st.latency.push(now - e.r);
      }
    });
    sock.on('fleet', (m: FleetDeltaMsg) => {
      st.fleetMsgs++;
      st.fleetStates += m.states.length;
    });
    await new Promise<void>((res, rej) => {
      sock.once('connect', () => res());
      sock.once('connect_error', rej);
    });
    const ack: any = await new Promise((res) => sock.emit('subscribe', { groups: ['stress'], devices: devs }, res));
    if (!ack.ok) throw new Error(`subscribe failed: ${ack.error}`);
    if (!startCursor) startCursor = ack.watermark;
    clients.push(st);
  }

  // ---- Generator ----
  const client = new IngestClient(URL, KEY, { batchSize: +a.batch!, concurrency: +a.concurrency!, outboxMax: 200_000, baseBackoffMs: 100, maxBackoffMs: 5000 });
  const seq = new Map<string, number>();
  let offered = 0;
  let cursorDev = 0;
  let currentRate = RATE;
  const TICK = 100;
  let carry = 0;
  const gen = setInterval(() => {
    carry += (currentRate * TICK) / 1000;
    const n = Math.floor(carry);
    carry -= n;
    const now = Date.now();
    const out: TelemetryEventIn[] = [];
    for (let k = 0; k < n; k++) {
      const d = deviceIds[cursorDev++ % DEVICES];
      const q = seq.get(d) ?? 0;
      seq.set(d, q + 1);
      out.push({
        eventId: `${d}:${session}:${q}`,
        deviceId: d,
        sessionId: session,
        seq: q,
        observedAt: now,
        metrics: { tempC: 4 + Math.random() * 2, humidityPct: 50, batteryPct: 80, cooling: 'on' },
      });
    }
    offered += n;
    if (out.length) client.push(out);
  }, TICK);

  // ---- Server metric sampling ----
  const samples: { phase: string; t: number; m: PlatformMetrics }[] = [];
  let phase = 'warmup';
  const sampler = setInterval(async () => {
    try {
      samples.push({ phase, t: Date.now(), m: await getJson<PlatformMetrics>('/metrics', tok) });
    } catch {
      /* ignore */
    }
  }, 1000);

  const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
  await sleep(WARMUP);
  const base = { offered, ...structuredClone(client.stats), ack: client.stats.ackLatencyMs.length };
  client.stats.ackLatencyMs = [];
  phase = 'steady';
  measuring = true;
  const tSteady = Date.now();
  await sleep(DURATION);
  const steadyEnd = { offered, ...structuredClone(client.stats) };
  const steadyAck = [...client.stats.ackLatencyMs];
  const steadyLatency = clients.flatMap((c) => c.latency);
  measuring = false;
  const tSteadyEnd = Date.now();

  let burst: any = null;
  if (BURST_RATE > 0) {
    phase = 'burst';
    currentRate = BURST_RATE;
    await sleep(BURST_SEC);
    currentRate = RATE;
    burst = { rate: BURST_RATE, sec: BURST_SEC, overload503: client.stats.overload503 - steadyEnd.overload503, rateLimited429: client.stats.rateLimited429 - steadyEnd.rateLimited429, backlogAtEnd: client.pending };
  }
  phase = 'recovery';
  const tRec = Date.now();
  await sleep(RECOVERY);
  clearInterval(gen);
  // Drain the outbox.
  const drainStart = Date.now();
  while (client.pending > 0 && Date.now() - drainStart < 60_000) await sleep(0.2);
  const drainedMs = Date.now() - drainStart;
  await sleep(1.5); // final broadcasts
  clearInterval(sampler);

  // ---- Delivery completeness: compare with what MongoDB actually stored ----
  let expected = 0;
  let delivered = 0;
  let missing = 0;
  const perDevicePersisted = new Map<string, Set<string>>();
  const uniqueDevs = [...new Set(clients.flatMap((c) => c.devices))];
  for (const d of uniqueDevs) {
    const ids = new Set<string>();
    let cur = startCursor;
    for (;;) {
      const r: any = await getJson(`/telemetry/${d}/since?cursor=${cur}`, tok);
      for (const x of r.readings) if (x.s === session) ids.add(x.id);
      if (!r.truncated || !r.readings.length) break;
      cur = r.readings[r.readings.length - 1].c;
    }
    perDevicePersisted.set(d, ids);
  }
  for (const c of clients) {
    for (const d of c.devices) {
      const want = perDevicePersisted.get(d)!;
      const got = c.ids.get(d)!;
      expected += want.size;
      for (const id of want) if (got.has(id)) delivered++;
      missing += [...want].filter((id) => !got.has(id)).length;
    }
  }

  const final = await getJson<PlatformMetrics>('/metrics', tok);
  const steadySamples = samples.filter((s) => s.phase === 'steady').map((s) => s.m);
  const avg = (f: (m: PlatformMetrics) => number | null) => {
    const v = steadySamples.map(f).filter((x): x is number => x != null);
    return v.length ? Math.round((v.reduce((x, y) => x + y, 0) / v.length) * 10) / 10 : null;
  };
  const max = (f: (m: PlatformMetrics) => number | null) => {
    const v = steadySamples.map(f).filter((x): x is number => x != null);
    return v.length ? Math.max(...v) : null;
  };
  const steadySec = (tSteadyEnd - tSteady) / 1000;
  const result = {
    label: a.label || null,
    at: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      memGb: Math.round(os.totalmem() / 1e9),
      note: 'Load generator, socket clients, server and MongoDB (Docker) on the same machine.',
    },
    config: { rate: RATE, devices: DEVICES, clients: CLIENTS, devicesPerClient: PER_CLIENT, warmupSec: WARMUP, durationSec: DURATION, batch: +a.batch!, concurrency: +a.concurrency!, burstRate: BURST_RATE, burstSec: BURST_SEC },
    steady: {
      seconds: Math.round(steadySec),
      offered: steadyEnd.offered - base.offered,
      persistedAcked: steadyEnd.sent - base.sent,
      offeredPerSec: Math.round((steadyEnd.offered - base.offered) / steadySec),
      persistedPerSec: Math.round((steadyEnd.sent - base.sent) / steadySec),
      rejectedInvalid: steadyEnd.rejected - base.rejected,
      overload503: steadyEnd.overload503 - base.overload503,
      rateLimited429: steadyEnd.rateLimited429 - base.rateLimited429,
      retries: steadyEnd.retries - base.retries,
      ingestAckMs: { p50: pct(steadyAck, 50), p95: pct(steadyAck, 95), p99: pct(steadyAck, 99), n: steadyAck.length },
      deliveryMs: { p50: pct(steadyLatency, 50), p95: pct(steadyLatency, 95), p99: pct(steadyLatency, 99), n: steadyLatency.length },
      server: {
        persistedPerSecAvg: avg((m) => m.ingest.persistedPerSec),
        queueDepthMax: max((m) => m.queue.depth),
        dbBatchP95Avg: avg((m) => m.db.batchP95),
        dbBatchSizeAvg: avg((m) => m.db.lastBatchSize),
        pipelineP95Avg: avg((m) => m.pipeline.p95),
        cpuPctAvg: avg((m) => m.process.cpuPct),
        cpuPctMax: max((m) => m.process.cpuPct),
        rssMbMax: max((m) => m.process.rssMb),
        eventLoopP99MsMax: max((m) => m.process.eventLoopP99Ms),
        socketEmitsPerSecAvg: avg((m) => m.sockets.emittedPerSec),
        laggingSocketsMax: max((m) => m.sockets.lagging),
      },
    },
    burst,
    recovery: { seconds: RECOVERY, outboxDrainMs: drainedMs, pendingAfterDrain: client.pending, queueDepthAtEnd: final.queue.depth },
    totals: { offered, ...client.stats, ackLatencyMs: undefined, duplicates: client.stats.duplicates },
    delivery: {
      definition: 'For every reading MongoDB stored for a subscribed device during the run, was it received by each subscribed client?',
      expected,
      delivered,
      missing,
      ratio: expected ? Math.round((delivered / expected) * 10000) / 100 : null,
      fleetDeltaMsgsPerClient: Math.round(clients.reduce((x, c) => x + c.fleetMsgs, 0) / CLIENTS),
      fleetStatesPerClient: Math.round(clients.reduce((x, c) => x + c.fleetStates, 0) / CLIENTS),
    },
  };
  void tRec;

  const file = path.resolve(here, `../results/${new Date().toISOString().replace(/[:.]/g, '-')}${a.label ? '-' + a.label : ''}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  const s = result.steady;
  console.log(`
| metric | value |
|---|---|
| offered / persisted (steady) | ${s.offeredPerSec} / ${s.persistedPerSec} ev/s over ${s.seconds}s |
| ingest ack p50/p95/p99 (HTTP → durable 200) | ${s.ingestAckMs.p50} / ${s.ingestAckMs.p95} / ${s.ingestAckMs.p99} ms |
| delivery p50/p95/p99 (server receivedAt → client) | ${s.deliveryMs.p50} / ${s.deliveryMs.p95} / ${s.deliveryMs.p99} ms (n=${s.deliveryMs.n}) |
| server pipeline p95 (receivedAt → emit), avg | ${s.server.pipelineP95Avg} ms |
| DB batch p95 avg / avg batch size | ${s.server.dbBatchP95Avg} ms / ${s.server.dbBatchSizeAvg} |
| queue depth max | ${s.server.queueDepthMax} |
| 503 / 429 / retries (steady) | ${s.overload503} / ${s.rateLimited429} / ${s.retries} |
| server CPU avg/max · RSS max · loop p99 max | ${s.server.cpuPctAvg}% / ${s.server.cpuPctMax}% · ${s.server.rssMbMax} MB · ${s.server.eventLoopP99MsMax} ms |
| delivery completeness | ${result.delivery.delivered}/${result.delivery.expected} (${result.delivery.ratio}%) |
${burst ? `| burst ${burst.rate} ev/s × ${burst.sec}s | 503: ${burst.overload503}, 429: ${burst.rateLimited429}, client backlog at end ${burst.backlogAtEnd} |\n` : ''}| recovery: outbox drained in | ${drainedMs} ms (pending ${result.recovery.pendingAfterDrain}, server queue ${result.recovery.queueDepthAtEnd}) |
`);
  console.log(`[lt] saved ${path.relative(process.cwd(), file)}`);

  for (const c of clients) c.sock.disconnect();
  if (simWas) await postJson('/sim/control', tok, { running: simWas.running });
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
