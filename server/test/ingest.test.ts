import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IngestClient } from '../../simulator/src/client.js';
import { AGENT_KEY, ev, startApp, until, type TestApp } from './helpers.js';

describe('authentication & authorisation (REST)', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.stop());

  it('rejects bad credentials and unauthenticated requests', async () => {
    const bad = await fetch(`${app.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'operator', password: 'nope' }) });
    expect(bad.status).toBe(401);
    expect((await fetch(`${app.url}/api/fleet`)).status).toBe(401);
    expect((await app.get('/fleet', 'not-a-jwt')).status).toBe(401);
  });

  it('scopes data to the user’s groups', async () => {
    const tok = await app.login('viewer.deccan');
    const f = await app.get('/fleet', tok);
    expect(f.status).toBe(200);
    expect(new Set(f.body.devices.map((d: any) => d.groupId))).toEqual(new Set(['deccan']));
    expect((await app.get('/devices/WC-S01', tok)).status).toBe(404);
    expect((await app.get('/telemetry/WC-S01', tok)).status).toBe(404);
  });

  it('enforces operator-only actions', async () => {
    const viewer = await app.login('viewer.deccan');
    expect((await app.send('PUT', '/rules', viewer, {})).status).toBe(403);
    expect((await app.send('POST', '/sim/control', viewer, { running: false })).status).toBe(403);
    expect((await app.send('POST', '/demo/reset', viewer, { confirm: 'RESET' })).status).toBe(403);
    const op = await app.login('operator');
    expect((await app.send('POST', '/demo/reset', op, {})).status).toBe(400); // confirmation required
  });

  it('rejects ingestion without a valid agent credential', async () => {
    const r = await app.ingest([ev('DC-S01', 0, Date.now())], 'test-agent.wrong-secret-xxxxxxxx');
    expect(r.status).toBe(401);
    const r2 = await app.ingest([ev('DC-S01', 0, Date.now())], 'nobody.whatever-secret-123456');
    expect(r2.status).toBe(401);
  });
});

describe('ingestion validation, idempotency and ordering', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.stop());

  it('validates batch shape, size and payload', async () => {
    expect((await app.ingest([])).status).toBe(400);
    const many = Array.from({ length: 501 }, (_, i) => ev('DC-S01', i, Date.now()));
    expect((await app.ingest(many)).status).toBe(400);
    const res = await fetch(`${app.url}/api/ingest/batch`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Agent ${AGENT_KEY}` }, body: '{"events": [' });
    expect(res.status).toBe(400);
    const huge = await fetch(`${app.url}/api/ingest/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Agent ${AGENT_KEY}` },
      body: JSON.stringify({ events: [{ pad: 'x'.repeat(600_000) }] }),
    });
    expect(huge.status).toBe(413);
  });

  it('rejects individual invalid events but persists the valid ones', async () => {
    const now = Date.now();
    const r = await app.ingest([
      ev('DC-S01', 100, now - 1000),
      ev('DC-S01', 101, now - 500, 999), // temperature out of range
      ev('NOPE-1', 0, now), // unknown device
      ev('DC-S01', 102, now + 120_000), // too far in the future
      ev('DC-S01', 103, now - 7 * 3600_000), // older than the late-data window
      { ...ev('DC-S01', 104, now), extra: true }, // unknown field
    ]);
    expect(r.status).toBe(200);
    expect(r.body.persisted).toBe(1);
    expect(r.body.rejected.map((x: any) => x.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it('is idempotent: re-sending the same events stores them once', async () => {
    const now = Date.now();
    const batch = Array.from({ length: 50 }, (_, i) => ev('DC-S02', i, now - 60_000 + i * 1000, 5, 'idem'));
    const a = await app.ingest(batch);
    const b = await app.ingest(batch);
    const c = await app.ingest([...batch.slice(0, 10), ...batch.slice(0, 10)]); // duplicates inside one batch
    expect(a.body).toMatchObject({ persisted: 50, duplicates: 0 });
    expect(b.body).toMatchObject({ persisted: 0, duplicates: 50 });
    expect(c.body).toMatchObject({ persisted: 0, duplicates: 20 });
    expect(await app.cg.db.col.telemetry.countDocuments({ d: 'DC-S02' })).toBe(50);
  });

  it('treats a re-minted eventId at the same (device, session, seq) as a duplicate', async () => {
    const now = Date.now();
    await app.ingest([ev('DC-S04', 1, now - 2000, 5, 'rm')]);
    const r = await app.ingest([{ ...ev('DC-S04', 1, now - 2000, 6, 'rm'), eventId: 'different-id' }]);
    expect(r.body.duplicates).toBe(1);
  });

  it('stores out-of-order readings as late without moving current state backwards', async () => {
    const now = Date.now();
    await app.ingest([ev('DC-S05', 0, now - 4000, 4.0, 'oo'), ev('DC-S05', 1, now - 3000, 4.5, 'oo'), ev('DC-S05', 3, now - 1000, 6.0, 'oo')]);
    const r = await app.ingest([ev('DC-S05', 2, now - 2000, 9.9, 'oo')]);
    expect(r.body).toMatchObject({ persisted: 1, late: 1 });
    const st = app.cg.engine.state('DC-S05')!;
    expect(st.tc).toBe(6.0);
    expect(app.cg.engine.position('DC-S05')).toMatchObject({ seq: 3 });
    const late = await app.cg.db.col.telemetry.findOne({ _id: 'DC-S05:oo:2' });
    expect(late?.late).toBe(true);
    // History shows all four in observed-time order.
    const tok = await app.login('operator');
    const h = await app.get(`/telemetry/DC-S05?from=${now - 10_000}&mode=raw`, tok);
    expect(h.body.readings.map((x: any) => x.q)).toEqual([0, 1, 2, 3]);
  });

  it('accepts a new source session (device restart) only when it is newer in time', async () => {
    const now = Date.now();
    await app.ingest([ev('DC-S06', 500, now - 5000, 5, 'boot1')]);
    await app.ingest([ev('DC-S06', 0, now - 1000, 4.2, 'boot2')]); // restart: seq resets
    expect(app.cg.engine.position('DC-S06')).toMatchObject({ sessionId: 'boot2', seq: 0 });
    const old = await app.ingest([ev('DC-S06', 501, now - 4000, 7, 'boot1')]); // stale old-session reading
    expect(old.body.late).toBe(1);
    expect(app.cg.engine.state('DC-S06')!.tc).toBe(4.2);
  });
});

describe('overload, rate limiting and client retry', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startApp({ QUEUE_CAPACITY: 100, AGENT_RATE_EPS: 300 });
  });
  afterAll(() => app.stop());

  it('returns 503 + Retry-After when a batch does not fit the bounded queue, and stores nothing from it', async () => {
    const now = Date.now();
    const big = Array.from({ length: 150 }, (_, i) => ev('WC-S01', i, now - 200_000 + i * 1000, 5, 'ovl'));
    const r = await app.ingest(big);
    expect(r.status).toBe(503);
    expect(r.body.retryable).toBe(true);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await app.cg.db.col.telemetry.countDocuments({ s: 'ovl' })).toBe(0);
    expect(app.cg.pipeline.depth).toBeLessThanOrEqual(100);
  });

  it('returns 429 when the per-agent event rate is exceeded', async () => {
    const now = Date.now();
    let saw429 = false;
    for (let k = 0; k < 10 && !saw429; k++) {
      const r = await app.ingest(Array.from({ length: 90 }, (_, i) => ev('WC-S02', k * 100 + i, now - 100_000 + k * 100 + i, 5, 'rl')));
      if (r.status === 429) {
        saw429 = true;
        expect(r.headers.get('retry-after')).toBeTruthy();
      }
    }
    expect(saw429).toBe(true);
  });

  it('simulator client backs off, retries idempotently and eventually delivers everything exactly once', async () => {
    await new Promise((r) => setTimeout(r, 2500)); // let the token bucket refill
    const client = new IngestClient(app.url, AGENT_KEY, { batchSize: 90, concurrency: 4, outboxMax: 10_000, baseBackoffMs: 50, maxBackoffMs: 800 });
    const now = Date.now();
    client.push(Array.from({ length: 1200 }, (_, i) => ev('WC-S03', i, now - 1_300_000 + i * 1000, 5, 'retry')));
    await until(() => client.pending === 0, 30_000, 50);
    expect(client.stats.retries).toBeGreaterThan(0); // it was throttled
    expect(client.stats.sent + client.stats.duplicates).toBe(1200);
    expect(await app.cg.db.col.telemetry.countDocuments({ s: 'retry' })).toBe(1200);
  });
});
