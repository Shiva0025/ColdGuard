import express, { type Request, type Response, type Router } from 'express';
import {
  AckSchema,
  COOLING_FROM_CODE,
  CommandRequestSchema,
  FaultSchema,
  GROUPS,
  GuestClaimSchema,
  IngestBatchSchema,
  LIMITS,
  LoginSchema,
  RulesSchema,
  SimControlSchema,
  TelemetryEventSchema,
  type Bucket,
  type TelemetryEventIn,
} from '@coldguard/shared';
import type { Filter } from 'mongodb';
import os from 'node:os';
import { guestFleet as guestFleetInfo } from '@coldguard/shared';
import { randomBytes } from 'node:crypto';
import type { AuthService } from './auth.js';
import type { Config } from './config.js';
import type { Database, TelemetryDoc } from './db.js';
import type { StateEngine } from './engine.js';
import { fromDoc, type IncidentManager } from './incidents.js';
import { OverloadError, toReading, type IngestPipeline } from './pipeline.js';
import type { SimControl } from './simControl.js';
import type { TunnelManager } from './tunnel.js';
import type { CommandManager } from './commands.js';
import { buildStory } from './replay.js';
import { verifyBlocks, sha256 as sha, type EvidenceChain } from './evidence.js';
import { genesisSeed } from '@coldguard/shared';

export interface RouteDeps {
  cfg: Config;
  db: Database;
  auth: AuthService;
  engine: StateEngine;
  pipeline: IngestPipeline;
  incidents: IncidentManager;
  sim: SimControl;
  commands: CommandManager;
  evidence: EvidenceChain;
  metrics: () => unknown;
  resetDemo: () => Promise<void>;
  onCatalogChange: (groupId: string) => void;
  tunnel: TunnelManager;
  /** The port this server is actually listening on. */
  port: () => number;
}

/** Token bucket keyed by agent, measured in events (not requests). */
class TokenBuckets {
  private b = new Map<string, { tokens: number; at: number }>();
  constructor(private ratePerSec: number, private burst: number) {}
  take(key: string, n: number): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = Date.now();
    const s = this.b.get(key) ?? { tokens: this.burst, at: now };
    s.tokens = Math.min(this.burst, s.tokens + ((now - s.at) / 1000) * this.ratePerSec);
    s.at = now;
    this.b.set(key, s);
    if (s.tokens >= n) {
      s.tokens -= n;
      return { ok: true };
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((n - s.tokens) / this.ratePerSec)) };
  }
}

/** Fixed-window limiter for login attempts per IP. */
function loginLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: () => void) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max) {
      res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000));
      return void res.status(429).json({ error: 'too many login attempts' });
    }
    if (hits.size > 10_000) hits.clear();
    next();
  };
}

const NICE_BUCKETS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000);

const EXPORT_MAX_ROWS = 100_000;
const ANALYTICS_MAX_INCIDENTS = 5000;

const num = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function buildRoutes(d: RouteDeps): Router {
  const { cfg, db, auth, engine, pipeline, incidents, sim, commands, evidence } = d;
  const r = express.Router();
  const buckets = new TokenBuckets(cfg.AGENT_RATE_EPS, cfg.AGENT_RATE_EPS * 2);
  // Phones: 1 Hz normally, but allow a 10-minute store-and-forward burst after a "tunnel".
  const phoneBuckets = new TokenBuckets(50, 1500);

  const canSeeDevice = (req: Request, deviceId: string) => {
    const info = engine.device(deviceId);
    if (!info) return null;
    const u = req.user!;
    if (u.deviceId) return u.deviceId === info.id ? info : null; // drivers see only their truck
    return u.groups.includes(info.groupId) ? info : null;
  };

  // ---- Health ------------------------------------------------------------
  r.get('/healthz', async (_req, res) => {
    try {
      await db.db.command({ ping: 1 });
      res.json({ ok: true, queueDepth: pipeline.depth });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // ---- Auth --------------------------------------------------------------
  r.post('/auth/login', loginLimiter(10, 60_000), express.json({ limit: '4kb' }), async (req, res) => {
    const p = LoginSchema.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: 'invalid login payload' });
    const out = await auth.login(p.data.username, p.data.password);
    if (!out) return void res.status(401).json({ error: 'invalid username or password' });
    res.json(out);
  });

  r.get('/me', auth.requireUser, (req, res) => res.json({ user: req.user }));

  // ---- Ingestion (agents) --------------------------------------------------
  r.post('/ingest/batch', auth.requireAgent, express.json({ limit: LIMITS.maxBodyBytes }), async (req, res) => {
    const agent = req.agent!;
    const shape = IngestBatchSchema.safeParse(req.body);
    if (!shape.success) {
      return void res.status(400).json({ error: 'invalid batch', detail: shape.error.issues.slice(0, 3).map((i) => i.message), retryable: false });
    }
    const raw = shape.data.events;
    pipeline.stats.offered.add(raw.length);
    const rl = (agent.deviceIds ? phoneBuckets : buckets).take(agent.agentId, raw.length);
    if (!rl.ok) {
      pipeline.stats.rateLimited.add(raw.length);
      res.setHeader('Retry-After', rl.retryAfterSec);
      return void res.status(429).json({ error: 'rate limited', retryable: true, retryAfterSec: rl.retryAfterSec });
    }

    const now = Date.now();
    const valid: TelemetryEventIn[] = [];
    const rejected: { index: number; eventId?: string; reason: string }[] = [];
    raw.forEach((e, index) => {
      const p = TelemetryEventSchema.safeParse(e);
      if (!p.success) {
        const iss = p.error.issues[0];
        return void rejected.push({ index, eventId: (e as any)?.eventId, reason: `${iss.path.join('.')}: ${iss.message}` });
      }
      const ev = p.data;
      const info = engine.device(ev.deviceId);
      if (!info) return void rejected.push({ index, eventId: ev.eventId, reason: 'unknown device' });
      const allowed = agent.deviceIds ? agent.deviceIds.includes(info.id) : agent.groups.includes(info.groupId);
      if (!allowed) return void rejected.push({ index, eventId: ev.eventId, reason: 'agent not authorised for device' });
      if (ev.observedAt > now + LIMITS.maxFutureSkewMs) return void rejected.push({ index, eventId: ev.eventId, reason: 'observedAt too far in the future' });
      if (ev.observedAt < now - LIMITS.maxAgeMs) return void rejected.push({ index, eventId: ev.eventId, reason: 'observedAt older than late-data window' });
      valid.push(ev);
    });
    pipeline.stats.rejected.add(rejected.length);
    if (valid.length === 0) return void res.status(400).json({ error: 'no valid events', rejected, retryable: false });

    try {
      const result = await pipeline.enqueue(valid, agent.agentId, now);
      const body = { ...result, rejected, committed: pipeline.committed };
      if (result.failed > 0) {
        // Storage failed for some events: retry the request (idempotent thanks to eventId dedupe).
        res.setHeader('Retry-After', 1);
        return void res.status(503).json({ error: 'persistence failed', retryable: true, ...body });
      }
      res.json(body);
    } catch (e) {
      if (e instanceof OverloadError) {
        res.setHeader('Retry-After', e.retryAfterSec);
        return void res.status(503).json({ error: 'overloaded', retryable: true, retryAfterSec: e.retryAfterSec, queueDepth: pipeline.depth });
      }
      throw e;
    }
  });

  // ---- Judges join by QR: claim a guest truck (public, invite-gated) --------
  const claimLimiter = loginLimiter(10, 60_000);
  r.post('/guest/claim', claimLimiter, express.json({ limit: '2kb' }), async (req, res) => {
    const p = GuestClaimSchema.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: p.error.issues[0]?.message ?? 'invalid' });
    const inv = (await db.col.settings.findOne({ _id: 'invite' }))?.invite;
    if (!inv || inv.code !== p.data.code || inv.expiresAt < Date.now()) return void res.status(403).json({ error: 'invite expired or invalid — ask the operator for a fresh QR code' });
    const now = new Date();
    const taken = new Set((await db.col.guests.find({ expiresAt: { $gt: now } }).toArray()).map((g) => g._id));
    if (taken.size >= inv.maxClaims) return void res.status(409).json({ error: 'all trucks are taken' });
    const free = engine.devicesIn(['guest']).sort((a, b) => a.id.localeCompare(b.id)).find((d) => !taken.has(d.id));
    if (!free) return void res.status(409).json({ error: 'all trucks are taken' });
    const ttlSec = 2 * 3600;
    const name = p.data.name;
    const truckName = `${name}'s truck`;
    const exp = new Date(Date.now() + ttlSec * 1000);
    try {
      await db.col.guests.insertOne({ _id: free.id, name, claimedAt: now, expiresAt: exp });
    } catch {
      // Expired claim on the same truck (or a race): take it over only if expired.
      const r2 = await db.col.guests.updateOne({ _id: free.id, expiresAt: { $lte: now } }, { $set: { name, claimedAt: now, expiresAt: exp } });
      if (!r2.modifiedCount) return void res.status(409).json({ error: 'truck just got taken, try again' });
    }
    await db.col.devices.updateOne({ _id: free.id }, { $set: { name: truckName } });
    engine.register([{ ...free, name: truckName }]);
    d.onCatalogChange('guest');
    const out = auth.signDriver(free.id, name, ttlSec);
    res.json({ ...out, device: { ...free, name: truckName }, expiresAt: exp.getTime() });
  });

  // ---- Everything below requires a user --------------------------------
  r.use(auth.requireUser);

  r.post('/guest/invite', auth.requireRole('operator'), express.json({ limit: '1kb' }), async (req, res) => {
    const ttlMin = Math.min(Math.max(num(req.body?.ttlMin, 30), 1), 240);
    const invite = { code: randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 8), expiresAt: Date.now() + ttlMin * 60_000, maxClaims: 12, createdBy: req.user!.username };
    await db.col.settings.updateOne({ _id: 'invite' }, { $set: { invite, updatedAt: new Date() } }, { upsert: true });
    res.json({ invite, lanAddresses: lanAddresses() });
  });
  r.get('/guest/status', auth.requireRole('operator'), async (_req, res) => {
    const inv = (await db.col.settings.findOne({ _id: 'invite' }))?.invite ?? null;
    const guests = await db.col.guests.find({ expiresAt: { $gt: new Date() } }).sort({ claimedAt: 1 }).toArray();
    res.json({
      invite: inv && inv.expiresAt > Date.now() ? inv : null,
      lanAddresses: lanAddresses(),
      tunnel: d.tunnel.status(),
      trucks: guests.map((g) => ({ deviceId: g._id, name: g.name, claimedAt: +g.claimedAt, state: engine.state(g._id) })),
    });
  });
  // Public tunnel for venues whose Wi-Fi isolates clients (phones cannot reach the LAN address).
  r.post('/guest/tunnel', auth.requireRole('operator'), express.json({ limit: '1kb' }), async (req, res) => {
    // Only this app may be exposed: the API port itself, or the web origin(s) from CORS_ORIGIN (Vite in dev).
    const own = d.port();
    const webPorts = cfg.CORS_ORIGIN.split(',').map((o) => { try { const u = new URL(o.trim()); return /^(localhost|127\.0\.0\.1)$/.test(u.hostname) ? Number(u.port) : 0; } catch { return 0; } }).filter(Boolean);
    const allowed = [...new Set([...webPorts, own])];
    const asked = num(req.body?.port, 0);
    const port = allowed.includes(asked) ? asked : cfg.STATIC_DIR ? own : allowed[0];
    const st = await d.tunnel.start(`http://localhost:${port}`);
    res.status(st.status === 'on' ? 200 : 502).json(st);
  });
  r.delete('/guest/tunnel', auth.requireRole('operator'), (_req, res) => {
    d.tunnel.stop();
    res.json(d.tunnel.status());
  });
  r.post('/guest/release', auth.requireRole('operator'), async (_req, res) => {
    await db.col.guests.deleteMany({});
    await db.col.settings.updateOne({ _id: 'invite' }, { $unset: { invite: '' } });
    for (const g of guestFleetInfo()) {
      await db.col.devices.updateOne({ _id: g.id }, { $set: { name: g.name } });
      engine.register([g]);
    }
    d.onCatalogChange('guest');
    res.json({ ok: true });
  });

  r.get('/fleet', (req, res) => {
    const want = String(req.query.groups ?? '').split(',').filter(Boolean);
    const groups = (want.length ? want : req.user!.groups).filter((g) => req.user!.groups.includes(g));
    const watermark = pipeline.committed;
    const own = req.user!.deviceId ? engine.device(req.user!.deviceId) : undefined;
    const devices = own ? [own] : engine.devicesIn(groups);
    res.json({
      groups: GROUPS.filter((g) => req.user!.groups.includes(g.id)),
      devices,
      states: devices.map((x) => engine.state(x.id)),
      sparks: Object.fromEntries(devices.map((x) => [x.id, engine.spark(x.id)])),
      rules: engine.rules,
      watermark,
      serverTime: Date.now(),
    });
  });

  r.get('/devices/:id', (req, res) => {
    const info = canSeeDevice(req, req.params.id);
    if (!info) return void res.status(404).json({ error: 'not found' });
    res.json({ device: info, state: engine.state(info.id), rules: engine.rules });
  });

  /**
   * History for one device.
   * mode=raw  : readings with from ≤ t ≤ to, ascending (t,_id), ≤ 5000/page, keyset pagination via `after`.
   * mode=agg  : min/max/avg buckets for [from, aggEnd) + raw tail readings for [aggEnd, to].
   * mode=auto : raw if the range holds ≤ 5000 readings, else agg.
   * `watermark` = commit cursor read BEFORE the query: every reading with c ≤ watermark is visible.
   */
  r.get('/telemetry/:id', async (req, res) => {
    const info = canSeeDevice(req, req.params.id);
    if (!info) return void res.status(404).json({ error: 'not found' });
    const watermark = pipeline.committed;
    const now = Date.now();
    const to = Math.min(num(req.query.to, now), now + LIMITS.maxFutureSkewMs);
    const from = Math.max(num(req.query.from, to - 15 * 60_000), to - cfg.RETENTION_HOURS * 3600_000);
    if (!(from < to)) return void res.status(400).json({ error: 'from must be < to' });
    const mode = String(req.query.mode ?? 'auto');
    if (!['auto', 'raw', 'agg'].includes(mode)) return void res.status(400).json({ error: 'mode must be auto|raw|agg' });
    const maxRaw = Math.min(num(req.query.limit, LIMITS.maxHistoryRawPoints), LIMITS.maxHistoryRawPoints);
    const range: Filter<TelemetryDoc> = { d: info.id, t: { $gte: new Date(from), $lte: new Date(to) } };

    let useRaw = mode === 'raw';
    if (mode === 'auto') useRaw = (await db.col.telemetry.countDocuments(range, { limit: maxRaw + 1 })) <= maxRaw;

    if (useRaw) {
      const q: Filter<TelemetryDoc> = { ...range };
      const after = typeof req.query.after === 'string' ? req.query.after : '';
      if (after) {
        const i = after.indexOf('|');
        const at = new Date(Number(after.slice(0, i)));
        const aid = after.slice(i + 1);
        q.$or = [{ t: { $gt: at } }, { t: at, _id: { $gt: aid } }];
      }
      const docs = await db.col.telemetry.find(q).sort({ t: 1, _id: 1 }).limit(maxRaw + 1).toArray();
      const truncated = docs.length > maxRaw;
      if (truncated) docs.pop();
      const last = docs[docs.length - 1];
      return void res.json({
        mode: 'raw',
        from,
        to,
        watermark,
        readings: docs.map(toReading),
        truncated,
        nextAfter: truncated && last ? `${+last.t}|${last._id}` : null,
      });
    }

    const span = to - from;
    const bucketMs = NICE_BUCKETS.find((b) => span / b <= LIMITS.maxHistoryBuckets) ?? NICE_BUCKETS[NICE_BUCKETS.length - 1];
    const aggEnd = Math.max(from, Math.min(to, Math.floor(now / bucketMs) * bucketMs));
    const [aggRows, tail] = await Promise.all([
      db.col.telemetry
        .aggregate<Bucket & { _id: number }>([
          { $match: { d: info.id, t: { $gte: new Date(from), $lt: new Date(aggEnd) } } },
          { $set: { tl: { $toLong: '$t' } } },
          {
            $group: {
              _id: { $subtract: ['$tl', { $mod: ['$tl', bucketMs] }] },
              n: { $sum: 1 },
              tMin: { $min: '$tc' },
              tMax: { $max: '$tc' },
              tAvg: { $avg: '$tc' },
              h: { $avg: '$h' },
              b: { $min: '$b' },
              fault: { $sum: { $cond: [{ $eq: ['$cs', 2] }, 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
          { $limit: LIMITS.maxHistoryBuckets + 2 },
        ])
        .toArray(),
      db.col.telemetry
        .find({ d: info.id, t: { $gte: new Date(aggEnd), $lte: new Date(to) } })
        .sort({ t: 1, _id: 1 })
        .limit(maxRaw)
        .toArray(),
    ]);
    res.json({
      mode: 'agg',
      from,
      to,
      watermark,
      bucketMs,
      aggEnd,
      buckets: aggRows.map(({ _id, ...b }) => ({ ...b, t: _id, tAvg: Math.round(b.tAvg * 100) / 100, h: Math.round(b.h * 10) / 10 })),
      readings: tail.map(toReading),
      truncated: tail.length >= maxRaw,
    });
  });

  /** Reconnect catch-up: everything persisted for the device after `cursor`, in commit order. */
  r.get('/telemetry/:id/since', async (req, res) => {
    const info = canSeeDevice(req, req.params.id);
    if (!info) return void res.status(404).json({ error: 'not found' });
    const cursor = num(req.query.cursor, NaN);
    if (!Number.isFinite(cursor)) return void res.status(400).json({ error: 'cursor required' });
    const watermark = pipeline.committed;
    const limit = LIMITS.maxCatchUpEvents;
    const docs = await db.col.telemetry.find({ d: info.id, c: { $gt: cursor } }).sort({ c: 1 }).limit(limit + 1).toArray();
    const truncated = docs.length > limit;
    if (truncated) docs.pop();
    res.json({ readings: docs.map(toReading), truncated, watermark });
  });

  /**
   * CSV export of raw readings for one device and time range (streamed from a cursor,
   * capped at EXPORT_MAX_ROWS; the X-Truncated header says whether the cap was hit).
   */
  r.get('/telemetry/:id/export.csv', async (req, res) => {
    const info = canSeeDevice(req, String(req.params.id));
    if (!info) return void res.status(404).json({ error: 'not found' });
    const now = Date.now();
    const to = Math.min(num(req.query.to, now), now + LIMITS.maxFutureSkewMs);
    const from = Math.max(num(req.query.from, to - 15 * 60_000), to - cfg.RETENTION_HOURS * 3600_000);
    if (!(from < to)) return void res.status(400).json({ error: 'from must be < to' });
    const range: Filter<TelemetryDoc> = { d: info.id, t: { $gte: new Date(from), $lte: new Date(to) } };
    const total = await db.col.telemetry.countDocuments(range, { limit: EXPORT_MAX_ROWS + 1 });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="coldguard-${info.id}-${new Date(from).toISOString().replace(/[:.]/g, '-')}.csv"`);
    res.setHeader('X-Truncated', total > EXPORT_MAX_ROWS ? '1' : '0');
    res.write('eventId,deviceId,sessionId,seq,observedAt,receivedAt,tempC,humidityPct,batteryPct,cooling,doorOpen,routeProgress,late,commitCursor\n');
    const cursor = db.col.telemetry.find(range).sort({ t: 1, _id: 1 }).limit(EXPORT_MAX_ROWS);
    try {
      let chunk = '';
      let n = 0;
      for await (const doc of cursor) {
        const x = toReading(doc);
        chunk +=
          [
            x.id,
            x.d,
            x.s,
            x.q,
            new Date(x.t).toISOString(),
            new Date(x.r).toISOString(),
            x.tc,
            x.h,
            x.b,
            COOLING_FROM_CODE[x.cs] ?? x.cs,
            x.door === undefined ? '' : x.door,
            x.p === undefined ? '' : x.p,
            x.late ? 1 : 0,
            x.c,
          ].join(',') + '\n';
        if (++n % 500 === 0) {
          if (!res.write(chunk)) await new Promise((ok) => res.once('drain', ok));
          chunk = '';
        }
      }
      res.end(chunk);
    } catch {
      res.destroy(); // headers already sent: abort so the client sees a failed download, not a short file
    } finally {
      await cursor.close().catch(() => {});
    }
  });

  // ---- Incidents ----------------------------------------------------------
  /**
   * Response analytics over the user's corridors: how many incidents, how fast they were
   * acknowledged (triggered → ack) and resolved (triggered → resolved). Medians, measured
   * from stored incident documents only.
   */
  r.get('/analytics/incidents', async (req, res) => {
    const hours = Math.min(Math.max(num(req.query.hours, 24), 1), 168);
    const since = Date.now() - hours * 3600_000;
    const filter: Record<string, unknown> = req.user!.deviceId ? { deviceId: req.user!.deviceId } : { groupId: { $in: req.user!.groups } };
    filter.triggeredAt = { $gte: since };
    const docs = (await db.col.incidents.find(filter).sort({ triggeredAt: -1 }).limit(ANALYTICS_MAX_INCIDENTS).toArray()).map(fromDoc);
    const median = (xs: number[]) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      const m = s.length >> 1;
      return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
    };
    const ackSec = (i: (typeof docs)[number]) => (i.ack ? Math.max(0, (i.ack.at - i.triggeredAt) / 1000) : null);
    const resSec = (i: (typeof docs)[number]) => (i.resolvedAt != null ? Math.max(0, (i.resolvedAt - i.triggeredAt) / 1000) : null);
    const summarise = (list: typeof docs) => {
      const acks = list.map(ackSec).filter((x): x is number => x != null);
      const ress = list.map(resSec).filter((x): x is number => x != null);
      return {
        total: list.length,
        critical: list.filter((i) => i.severity === 'critical').length,
        active: list.filter((i) => i.active).length,
        unacknowledged: list.filter((i) => i.active && !i.ack).length,
        acknowledged: acks.length,
        resolved: ress.length,
        medianAckSec: median(acks),
        medianResolveSec: median(ress),
      };
    };
    const groupBy = (key: (i: (typeof docs)[number]) => string) => {
      const m = new Map<string, typeof docs>();
      for (const i of docs) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
      return [...m.entries()].map(([k, list]) => ({ key: k, ...summarise(list) })).sort((a, b) => b.total - a.total);
    };
    res.json({
      hours,
      since,
      generatedAt: Date.now(),
      truncated: docs.length >= ANALYTICS_MAX_INCIDENTS,
      overall: summarise(docs),
      byType: groupBy((i) => i.type),
      byGroup: groupBy((i) => i.groupId),
      topDevices: groupBy((i) => i.deviceId).slice(0, 5),
    });
  });

  r.get('/incidents', async (req, res) => {
    const groups = req.user!.groups;
    const filter: Record<string, unknown> = req.user!.deviceId ? { deviceId: req.user!.deviceId } : { groupId: { $in: groups } };
    if (req.query.scope !== 'all') filter.active = true;
    if (typeof req.query.deviceId === 'string' && !req.user!.deviceId) filter.deviceId = req.query.deviceId;
    const limit = Math.min(num(req.query.limit, 100), 500);
    const docs = await db.col.incidents.find(filter).sort({ triggeredAt: -1 }).limit(limit).toArray();
    res.json({ incidents: docs.map(fromDoc) });
  });

  /** Incident replay: the readings, commands and derived story around one incident. */
  r.get('/incidents/:id/replay', async (req, res) => {
    const doc = await db.col.incidents.findOne({ _id: String(req.params.id) });
    if (!doc || !req.user!.groups.includes(doc.groupId)) return void res.status(404).json({ error: 'not found' });
    const incident = fromDoc(doc);
    const info = engine.device(incident.deviceId);
    const now = Date.now();
    const from = Math.min(incident.openedAt, incident.triggeredAt) - 6 * 60_000;
    const to = Math.min(Math.max(incident.resolvedAt ?? now, incident.triggeredAt + 2 * 60_000) + 60_000, from + 2 * 3600_000, now);
    const [rdocs, related, cmds] = await Promise.all([
      db.col.telemetry
        .find({ d: incident.deviceId, t: { $gte: new Date(from), $lte: new Date(to) } })
        .sort({ t: 1, _id: 1 })
        .limit(LIMITS.maxHistoryRawPoints * 2)
        .toArray(),
      db.col.incidents
        .find({ deviceId: incident.deviceId, _id: { $ne: incident.id }, triggeredAt: { $gte: from, $lte: to } })
        .toArray(),
      db.col.commands.find({ deviceId: incident.deviceId, requestedAt: { $gte: from, $lte: to } }).sort({ requestedAt: 1 }).toArray(),
    ]);
    const readings = rdocs.map(toReading);
    const commandList = cmds.map(({ _id, ...c }) => ({ id: _id, ...c }));
    const story = buildStory({ readings, incident, related: related.map(fromDoc), commands: commandList, rules: engine.rules, tz: process.env.DISPLAY_TZ });
    res.json({ incident, device: info, from, to, readings, commands: commandList, rules: engine.rules, ...story });
  });

  r.post('/incidents/:id/ack', auth.requireRole('operator'), express.json({ limit: '4kb' }), async (req, res) => {
    const p = AckSchema.safeParse(req.body ?? {});
    if (!p.success) return void res.status(400).json({ error: 'invalid body' });
    const doc = await db.col.incidents.findOne({ _id: String(req.params.id) }, { projection: { groupId: 1 } });
    if (!doc || !req.user!.groups.includes(doc.groupId)) return void res.status(404).json({ error: 'not found' });
    const out = await incidents.acknowledge(String(req.params.id), req.user!.username, p.data.note);
    if (out === 'not_found') return void res.status(404).json({ error: 'not found' });
    if (out === 'already') return void res.status(409).json({ error: 'already acknowledged' });
    engine.touch(out.deviceId);
    res.json({ incident: out });
  });

  /** Data-integrity counters for one device (break-the-network panel). */
  r.get('/devices/:id/integrity', async (req, res) => {
    const info = canSeeDevice(req, String(req.params.id));
    if (!info) return void res.status(404).json({ error: 'not found' });
    const [persisted, lateStored] = await Promise.all([
      db.col.telemetry.countDocuments({ d: info.id }),
      db.col.telemetry.countDocuments({ d: info.id, late: true }),
    ]);
    const st = engine.state(info.id);
    const counters = pipeline.perDevice.get(info.id) ?? { duplicates: 0, backfilled: 0, late: 0 };
    res.json({
      deviceId: info.id,
      serverTime: Date.now(),
      persisted,
      lateStored,
      duplicatesRejectedSinceStart: counters.duplicates,
      backfilledSinceStart: counters.backfilled,
      statusBasis: { position: engine.position(info.id), observedAt: st?.t ?? null, receivedAt: st?.r ?? null, status: st?.status ?? null },
      pendingCommands: commands.pendingFor(info.id),
      uplink: sim.current()?.devices?.[info.id] ?? null,
      simulatorConnected: !!sim.current()?.connected,
    });
  });

  // ---- Tamper-evident evidence chain ------------------------------------------
  r.get('/devices/:id/evidence', async (req, res) => {
    const info = canSeeDevice(req, String(req.params.id));
    if (!info) return void res.status(404).json({ error: 'not found' });
    const tamper = (await db.col.settings.findOne({ _id: 'tamper' }))?.tamper;
    res.json({ ...(await evidence.verify(info.id)), tamperedDemo: tamper && tamper.eventId.startsWith(`${info.id}:`) ? tamper : null });
  });

  /** Demo only: silently alter one stored reading (as an insider would) to show the chain catching it. */
  r.post('/demo/tamper', auth.requireRole('operator'), express.json({ limit: '1kb' }), async (req, res) => {
    if (!cfg.ALLOW_DEMO_RESET) return void res.status(403).json({ error: 'demo tampering disabled (ALLOW_DEMO_RESET=false)' });
    const info = canSeeDevice(req, String(req.body?.deviceId ?? ''));
    if (!info) return void res.status(404).json({ error: 'unknown device' });
    const prev = (await db.col.settings.findOne({ _id: 'tamper' }))?.tamper;
    if (req.body?.undo) {
      if (!prev) return void res.status(409).json({ error: 'nothing to undo' });
      await db.col.telemetry.updateOne({ _id: prev.eventId }, { $set: { tc: prev.original } });
      await db.col.settings.updateOne({ _id: 'tamper' }, { $unset: { tamper: '' } });
      return void res.json({ restored: prev });
    }
    if (prev) return void res.status(409).json({ error: `undo the previous tamper of ${prev.eventId} first` });
    await evidence.flush();
    const blocks = await evidence.blocks(info.id, 30);
    if (!blocks.length) return void res.status(409).json({ error: 'no sealed readings yet' });
    // "Hide the excursion": take the hottest sealed reading of the last ~30 blocks and lower it by 3 °C.
    const doc = await db.col.telemetry.find({ d: info.id, c: { $gte: blocks[0].fromC, $lte: blocks[blocks.length - 1].toC } }).sort({ tc: -1 }).limit(1).next();
    if (!doc) return void res.status(409).json({ error: 'no sealed readings yet' });
    const altered = Math.round((doc.tc - 3) * 100) / 100;
    await db.col.telemetry.updateOne({ _id: doc._id }, { $set: { tc: altered } });
    const t = { eventId: doc._id, field: 'tc' as const, original: doc.tc, altered, at: Date.now() };
    await db.col.settings.updateOne({ _id: 'tamper' }, { $set: { tamper: t, updatedAt: new Date() } }, { upsert: true });
    res.json({ tampered: t });
  });

  /** Self-verifiable evidence report for one incident (readings + sealed blocks + verification). */
  r.get('/incidents/:id/report', async (req, res) => {
    const doc = await db.col.incidents.findOne({ _id: String(req.params.id) });
    if (!doc || !req.user!.groups.includes(doc.groupId)) return void res.status(404).json({ error: 'not found' });
    const incident = fromDoc(doc);
    await evidence.flush();
    const from = Math.min(incident.openedAt, incident.triggeredAt) - 6 * 60_000;
    const to = Math.min((incident.resolvedAt ?? Date.now()) + 60_000, from + 2 * 3600_000);
    const inWin = await db.col.telemetry.find({ d: incident.deviceId, t: { $gte: new Date(from), $lte: new Date(to) } }, { projection: { c: 1 } }).toArray();
    const cs = inWin.map((x) => x.c);
    const minC = Math.min(...cs);
    const maxC = Math.max(...cs);
    const blocks = cs.length
      ? (await db.col.evidence.find({ d: incident.deviceId, toC: { $gte: minC }, fromC: { $lte: maxC } }).sort({ n: 1 }).limit(400).toArray()).map(({ _id, ...b }) => b)
      : [];
    const byBlock = await evidence.readingsFor(incident.deviceId, blocks);
    const prev = blocks.length ? (blocks[0].n === 0 ? sha(genesisSeed(incident.deviceId)) : (await db.col.evidence.findOne({ _id: `${incident.deviceId}:${blocks[0].n - 1}` }))?.hash) : undefined;
    const verification = verifyBlocks(blocks, byBlock, prev);
    const sealedReadings = [...byBlock.values()].flat().sort((a, b) => a.c - b.c);
    const unsealed = cs.filter((c) => !blocks.some((b) => c >= b.fromC && c <= b.toC)).length;
    res.setHeader('content-disposition', `inline; filename="coldguard-report-${incident.id}.json"`);
    res.json({
      format: 'coldguard-evidence-report/v1',
      generatedAt: Date.now(),
      generatedBy: req.user!.username,
      disclaimer: 'Simulated cold-chain data for demonstration. Thresholds are demo settings, not storage guidance.',
      incident,
      device: engine.device(incident.deviceId),
      rules: engine.rules,
      window: { from, to },
      chain: { prevHashOfFirstBlock: prev ?? null, blocks, unsealedReadingsInWindow: unsealed },
      readings: sealedReadings,
      verification,
      howToVerify: 'npm run verify-report -- <this file>: recomputes every leaf, block and link hash from the readings in this file.',
    });
  });

  // ---- Operator commands (interactive rescue) -------------------------------
  r.get('/devices/:id/commands', async (req, res) => {
    const info = canSeeDevice(req, String(req.params.id));
    if (!info) return void res.status(404).json({ error: 'not found' });
    res.json({ commands: await commands.list(info.id, Math.min(num(req.query.limit, 20), 100)) });
  });
  r.post('/devices/:id/commands', auth.requireRole('operator'), express.json({ limit: '2kb' }), async (req, res) => {
    const info = canSeeDevice(req, String(req.params.id));
    if (!info) return void res.status(404).json({ error: 'not found' });
    const p = CommandRequestSchema.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: p.error.issues[0]?.message ?? 'invalid command' });
    res.status(202).json({ command: await commands.create(info.id, p.data.kind, req.user!.username, p.data.incidentId) });
  });

  // ---- Rules --------------------------------------------------------------
  r.get('/rules', (_req, res) => res.json({ rules: engine.rules, note: 'Demonstration settings, not vaccine-storage guidance.' }));
  r.put('/rules', auth.requireRole('operator'), express.json({ limit: '4kb' }), async (req, res) => {
    const p = RulesSchema.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: p.error.issues[0]?.message ?? 'invalid rules' });
    engine.rules = p.data;
    await db.col.settings.updateOne({ _id: 'rules' }, { $set: { rules: p.data, updatedAt: new Date(), updatedBy: req.user!.username } }, { upsert: true });
    res.json({ rules: engine.rules });
  });

  // ---- Platform metrics -----------------------------------------------------
  r.get('/metrics', (_req, res) => res.json(d.metrics()));

  // ---- Demo control (operator only) ---------------------------------------
  r.get('/sim', (_req, res) => res.json({ desired: sim.desired, status: sim.current(), faults: sim.faultLog.slice(0, 20), resetAllowed: cfg.ALLOW_DEMO_RESET }));
  r.post('/sim/control', auth.requireRole('operator'), express.json({ limit: '4kb' }), (req, res) => {
    const p = SimControlSchema.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: p.error.issues[0]?.message ?? 'invalid' });
    res.json({ desired: sim.update(p.data), connected: sim.connected() });
  });
  r.post('/sim/fault', auth.requireRole('operator'), express.json({ limit: '4kb' }), (req, res) => {
    const p = FaultSchema.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: p.error.issues[0]?.message ?? 'invalid' });
    if (p.data.deviceId && !canSeeDevice(req, p.data.deviceId)) return void res.status(404).json({ error: 'unknown device' });
    if (!sim.connected()) return void res.status(409).json({ error: 'simulator not connected' });
    sim.fault(p.data, req.user!.username);
    res.json({ ok: true });
  });
  r.post('/demo/reset', auth.requireRole('operator'), express.json({ limit: '1kb' }), async (req, res) => {
    if (!cfg.ALLOW_DEMO_RESET) return void res.status(403).json({ error: 'demo reset disabled (ALLOW_DEMO_RESET=false)' });
    if (req.body?.confirm !== 'RESET') return void res.status(400).json({ error: 'confirmation required: {"confirm":"RESET"}' });
    await d.resetDemo();
    res.json({ ok: true });
  });

  return r;
}

/** Addresses a phone on the same network could reach: skip Docker/VM bridges, prefer Wi-Fi, then Ethernet. */
function lanAddresses(): string[] {
  const out: { ip: string; rank: number }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|vmnet|vboxnet|lo|tun|tap|zt|tailscale)/i.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ ip: a.address, rank: /^(wl|wlan|wi)/i.test(name) ? 0 : /^(en|eth)/i.test(name) ? 1 : 2 });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map((x) => x.ip);
}
