import { io as ioc, type Socket } from 'socket.io-client';
import type { SubscribeAck, TelemetryEventIn } from '@coldguard/shared';
import { loadConfig, type Config } from '../src/config.js';
import { createColdGuard, type ColdGuard } from '../src/app.js';

export const MONGO = process.env.TEST_MONGO_URL ?? 'mongodb://localhost:27027';
export const AGENT_KEY = 'test-agent.test-secret-0123456789';
export const PASSWORD = 'test-password-123';

export interface TestApp {
  cg: ColdGuard;
  url: string;
  login(username: string): Promise<string>;
  ingest(events: unknown[], key?: string): Promise<{ status: number; body: any; headers: Headers }>;
  get(path: string, token: string): Promise<{ status: number; body: any }>;
  send(method: string, path: string, token: string, json?: unknown): Promise<{ status: number; body: any }>;
  socket(token: string): Promise<Socket>;
  stop(): Promise<void>;
}

export async function startApp(overrides: Partial<Record<keyof Config, unknown>> = {}): Promise<TestApp> {
  const dbName = `coldguard_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const cfg = loadConfig(
    {},
    {
      NODE_ENV: 'test',
      PORT: 0,
      MONGO_URL: `${MONGO}/${dbName}`,
      JWT_SECRET: 'test-jwt-secret-for-integration-tests-only',
      AGENT_KEY,
      DEMO_PASSWORD: PASSWORD,
      ALLOW_DEMO_RESET: 'true',
      TELEMETRY_EMIT_MS: 20,
      FLEET_EMIT_MS: 50,
      FLUSH_LINGER_MS: 0,
      ...overrides,
    },
  );
  const cg = await createColdGuard(cfg);
  const url = `http://127.0.0.1:${cg.port}`;
  const sockets: Socket[] = [];
  const app: TestApp = {
    cg,
    url,
    async login(username) {
      const r = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
      const b = await r.json();
      if (!b.token) throw new Error(`login failed for ${username}`);
      return b.token;
    },
    async ingest(events, key = AGENT_KEY) {
      const r = await fetch(`${url}/api/ingest/batch`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Agent ${key}` }, body: JSON.stringify({ events }) });
      return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
    },
    async get(path, token) {
      const r = await fetch(`${url}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    async send(method, path, token, json) {
      const r = await fetch(`${url}/api${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: json === undefined ? undefined : JSON.stringify(json),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    async socket(token) {
      const s = ioc(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
      sockets.push(s);
      await new Promise<void>((resolve, reject) => {
        s.once('connect', () => resolve());
        s.once('connect_error', (e) => reject(e));
      });
      return s;
    },
    async stop() {
      sockets.forEach((s) => s.disconnect());
      const db = cg.db.db;
      await cg.stop().catch(() => {});
      const { MongoClient } = await import('mongodb');
      const c = new MongoClient(`${MONGO}/${dbName}`);
      await c.connect();
      await c.db().dropDatabase();
      await c.close();
      void db;
    },
  };
  return app;
}

export function subscribe(s: Socket, req: { groups?: string[]; devices?: string[] }): Promise<SubscribeAck> {
  return new Promise((resolve) => s.emit('subscribe', { groups: req.groups ?? [], devices: req.devices ?? [] }, resolve));
}

let n = 0;
export function ev(deviceId: string, seq: number, observedAt: number, tempC = 5, sessionId = 's1', extra: Partial<TelemetryEventIn['metrics']> = {}): TelemetryEventIn {
  return {
    eventId: `${deviceId}:${sessionId}:${seq}`,
    deviceId,
    sessionId,
    seq,
    observedAt,
    metrics: { tempC, humidityPct: 50, batteryPct: 80, cooling: 'on', ...extra },
  };
}
export const uniq = () => `u${++n}`;
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return;
    await wait(stepMs);
  }
  throw new Error('condition not met in time');
}
