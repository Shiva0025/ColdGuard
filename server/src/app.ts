import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { TunnelManager } from './tunnel.js';
import { Server } from 'socket.io';
import { DEFAULT_RULES, RulesSchema, type PlatformMetrics, type SimCommandAck } from '@coldguard/shared';
import { AuthService } from './auth.js';
import type { Config } from './config.js';
import { connectDb, type Database } from './db.js';
import { StateEngine } from './engine.js';
import { IncidentManager } from './incidents.js';
import { IngestPipeline } from './pipeline.js';
import { Broadcaster } from './broadcaster.js';
import { attachSockets } from './socket.js';
import { buildRoutes } from './routes.js';
import { SimControl } from './simControl.js';
import { ProcessSampler } from './metrics.js';
import { seedData } from './seed.js';
import { CommandManager } from './commands.js';
import { EvidenceChain } from './evidence.js';

export interface ColdGuard {
  cfg: Config;
  db: Database;
  io: Server;
  httpServer: http.Server;
  engine: StateEngine;
  pipeline: IngestPipeline;
  incidents: IncidentManager;
  commands: CommandManager;
  evidence: EvidenceChain;
  broadcaster: Broadcaster;
  sim: SimControl;
  port: number;
  metrics(): PlatformMetrics;
  resetDemo(): Promise<void>;
  stop(): Promise<void>;
}

export async function createColdGuard(cfg: Config, opts: { tunnel?: TunnelManager } = {}): Promise<ColdGuard> {
  const db = await connectDb(cfg.MONGO_URL, { retentionHours: cfg.RETENTION_HOURS });
  if ((await db.col.users.estimatedDocumentCount()) === 0 || (await db.col.devices.countDocuments({ groupId: 'guest' })) === 0) {
    const s = await seedData(db.col, { demoPassword: cfg.DEMO_PASSWORD, agentKey: cfg.AGENT_KEY });
    console.log(`[boot] empty database seeded: ${s.devices} devices, users ${s.users.join(', ')}`);
  }

  const incidents = new IncidentManager(db.col);
  await incidents.load();
  const engine = new StateEngine(incidents);
  const devices = await db.col.devices.find().toArray();
  engine.register(devices.map(({ _id, ...d }) => ({ id: _id, ...d })));
  const settings = await db.col.settings.findOne({ _id: 'rules' });
  const parsedRules = RulesSchema.safeParse(settings?.rules);
  engine.rules = parsedRules.success ? parsedRules.data : { ...DEFAULT_RULES };
  for (const s of await db.col.deviceState.find().toArray()) engine.restore(s._id, s.pos, s.snapshot as any);
  const meta = await db.col.settings.findOne({ _id: 'cursor' });

  const pipeline = new IngestPipeline(
    db.col,
    engine,
    { capacity: cfg.QUEUE_CAPACITY, batchMax: cfg.DB_BATCH_MAX, lingerMs: cfg.FLUSH_LINGER_MS },
    meta?.cursorHighWater ?? 0,
  );
  const auth = new AuthService(db.col, cfg.JWT_SECRET, cfg.JWT_TTL);
  const sim = new SimControl();
  const tunnel = opts.tunnel ?? new TunnelManager();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'self'"], connectSrc: ["'self'", 'ws:', 'wss:'], imgSrc: ["'self'", 'data:'], styleSrc: ["'self'", "'unsafe-inline'"], fontSrc: ["'self'", 'data:'] },
      },
    }),
  );
  const origins = cfg.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins, credentials: false }));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: origins },
    maxHttpBufferSize: 64 * 1024, // clients only send small control messages
    pingInterval: 10_000,
    pingTimeout: 8_000,
  });
  const broadcaster = new Broadcaster(io, engine, {
    telemetryEmitMs: cfg.TELEMETRY_EMIT_MS,
    fleetEmitMs: cfg.FLEET_EMIT_MS,
    slowClientPackets: cfg.SLOW_CLIENT_PACKETS,
  });
  const driverRoom = (id: string) => `driver:${id}`;
  const isGuest = (id: string) => engine.device(id)?.groupId === 'guest';
  const commands = new CommandManager(
    db.col.commands,
    {
      label: (id) => (isGuest(id) ? "The judge's phone" : 'Simulator'),
      connected: (id) => (isGuest(id) ? (io.of('/').adapter.rooms.get(driverRoom(id))?.size ?? 0) > 0 : sim.connected()),
      send: async (msg) => {
        if (!isGuest(msg.deviceId)) return sim.sendCommand(msg);
        try {
          const acks = (await io.to(driverRoom(msg.deviceId)).timeout(3000).emitWithAck('command', msg)) as SimCommandAck[];
          return acks[0] ?? null;
        } catch {
          return null;
        }
      },
    },
    (id) => engine.device(id)?.groupId,
    (id) => {
      const st = engine.state(id);
      return { t: st?.t ?? null, tc: st?.tc ?? null };
    },
    (incidentId, text, by) => void incidents.note(incidentId, text, by),
  );
  await commands.load();
  sim.onCommandAck = (a) => commands.onAck(a);
  sim.onAgentConnected = () => commands.redeliver();
  commands.onChange((c) => broadcaster.onCommand(c));
  const evidence = new EvidenceChain(db.col.evidence, db.col.telemetry);
  await evidence.init();
  pipeline.onPersisted = (readings) => {
    evidence.onPersisted(readings);
    engine.applyPersisted(readings);
    commands.onReadings(readings);
    broadcaster.onPersisted(readings);
  };
  incidents.onChange((i) => {
    broadcaster.onIncident(i);
    engine.touch(i.deviceId);
  });
  attachSockets(io, { auth, engine, pipeline, sim, commands });

  const sampler = new ProcessSampler();
  const metrics = (): PlatformMetrics => {
    const s = pipeline.stats;
    const [b50, b95, b99] = s.batchMs.percentiles([50, 95, 99]);
    const [p50, p95, p99] = broadcaster.pipelineMs.percentiles([50, 95, 99]);
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const rn = (n: number | null) => (n == null ? null : r1(n));
    return {
      at: Date.now(),
      ingest: {
        acceptedPerSec: r1(s.accepted.rate()),
        persistedPerSec: r1(s.persisted.rate()),
        rejectedPerSec: r1(s.rejected.rate() + s.overload.rate() + s.rateLimited.rate()),
        duplicatePerSec: r1(s.duplicates.rate()),
        totals: {
          offered: s.offered.total,
          accepted: s.accepted.total,
          persisted: s.persisted.total,
          duplicates: s.duplicates.total,
          rejected: s.rejected.total,
          overload: s.overload.total,
          rateLimited: s.rateLimited.total,
          late: s.late.total,
        },
      },
      queue: { depth: pipeline.depth, capacity: pipeline.capacity, overloaded: s.overload.rate() > 0 },
      db: { batchP50: rn(b50), batchP95: rn(b95), batchP99: rn(b99), lastBatchSize: s.lastBatchSize },
      pipeline: { p50: rn(p50), p95: rn(p95), p99: rn(p99) },
      sockets: { connected: io.of('/').sockets.size, lagging: broadcaster.laggingCount, emittedPerSec: r1(broadcaster.emitted.rate()) },
      process: sampler.snapshot(),
      simulator: sim.current(),
    };
  };

  const resetDemo = async () => {
    await evidence.flush(); // let in-flight seals finish before their readings disappear
    await Promise.all([
      db.col.telemetry.deleteMany({}),
      db.col.incidents.deleteMany({}),
      db.col.deviceState.deleteMany({}),
      db.col.commands.deleteMany({}),
    ]);
    await evidence.resetAll();
    incidents.reset();
    commands.reset();
    engine.reset();
    io.emit('resync', { reason: 'server-restart' });
  };

  app.use('/api', buildRoutes({ cfg, db, auth, engine, pipeline, incidents, sim, commands, evidence, metrics, resetDemo, onCatalogChange: (g) => io.to(`group:${g}`).emit('catalog', { groupId: g }), tunnel, port: () => { const a = httpServer.address(); return typeof a === 'object' && a ? a.port : cfg.PORT; } }));

  if (cfg.STATIC_DIR && fs.existsSync(cfg.STATIC_DIR)) {
    const dir = path.resolve(cfg.STATIC_DIR);
    app.use(express.static(dir, { maxAge: '1h', index: false }));
    app.get(/^\/(?!api|socket\.io).*/, (_req, res) => res.sendFile(path.join(dir, 'index.html')));
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === 'entity.too.large') return void res.status(413).json({ error: 'payload too large', retryable: false });
    if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'malformed JSON', retryable: false });
    console.error('[http] error:', err?.message ?? err);
    res.status(500).json({ error: 'internal error', retryable: true });
  });

  // Periodic work.
  const timers: NodeJS.Timeout[] = [];
  timers.push(setInterval(() => engine.tickOffline(), 1000));
  timers.push(setInterval(() => io.to('platform').emit('platform', metrics()), 1000));
  const persistState = async () => {
    const rows = engine.takePersistDirty();
    if (rows.length) {
      await db.col.deviceState.bulkWrite(
        rows.map((r) => ({ updateOne: { filter: { _id: r.id }, update: { $set: { pos: r.pos, snapshot: r.snapshot as any, updatedAt: new Date() } }, upsert: true } })),
        { ordered: false },
      );
    }
    await db.col.settings.updateOne({ _id: 'cursor' }, { $set: { cursorHighWater: pipeline.committed, updatedAt: new Date() } }, { upsert: true });
  };
  timers.push(setInterval(() => persistState().catch((e) => console.error('[state] persist failed', e?.message)), 5000));

  pipeline.start();
  broadcaster.start();
  await new Promise<void>((resolve) => httpServer.listen(cfg.PORT, resolve));
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : cfg.PORT;

  if (cfg.SIM_AUTOSPAWN) {
    sim.spawnChild({ ...process.env, COLDGUARD_URL: `http://127.0.0.1:${port}`, AGENT_KEY: cfg.AGENT_KEY });
  }

  const stop = async () => {
    timers.forEach(clearInterval);
    broadcaster.stop();
    sim.stop();
    tunnel.stop();
    sampler.stop();
    await pipeline.stop();
    await incidents.flush();
    await commands.flush();
    await evidence.flush();
    evidence.stop();
    await persistState().catch(() => {});
    io.disconnectSockets(true);
    await new Promise<void>((r) => io.close(() => r()));
    await db.close();
  };

  return { cfg, db, io, httpServer, engine, pipeline, incidents, commands, evidence, broadcaster, sim, port, metrics, resetDemo, stop };
}
