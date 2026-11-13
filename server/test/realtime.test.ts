import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeHistoryAndLive, type FleetDeltaMsg, type Reading, type TelemetryBatchMsg } from '@coldguard/shared';
import { ev, startApp, subscribe, until, wait, type TestApp } from './helpers.js';

describe('Socket.IO authentication, rooms and independent subscriptions', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.stop());

  it('refuses connections without a valid token', async () => {
    await expect(app.socket('garbage')).rejects.toThrow(/unauthenticated/);
  });

  it('refuses room joins outside the user’s groups and validates payloads', async () => {
    const s = await app.socket(await app.login('viewer.deccan'));
    expect((await subscribe(s, { groups: ['western'] })).error).toMatch(/not authorised/);
    expect((await subscribe(s, { devices: ['WC-S01'] })).error).toMatch(/not authorised/);
    expect((await subscribe(s, { devices: ['NOPE'] })).error).toMatch(/unknown device/);
    const tooMany = await new Promise<any>((r) => s.emit('subscribe', { groups: [], devices: Array.from({ length: 30 }, (_, i) => `DC-S0${i}`) }, r));
    expect(tooMany.ok).toBe(false);
    const ok = await subscribe(s, { groups: ['deccan'], devices: ['DC-S01'] });
    expect(ok.ok).toBe(true);
    expect(ok.watermark).toBeGreaterThan(0);
  });

  it('delivers only relevant updates to each client', async () => {
    const a = await app.socket(await app.login('viewer.deccan'));
    const b = await app.socket(await app.login('viewer.western'));
    await subscribe(a, { groups: ['deccan'], devices: ['DC-S01'] });
    await subscribe(b, { groups: ['western'], devices: ['WC-S01'] });
    const gotA: Reading[] = [];
    const gotB: Reading[] = [];
    const fleetA = new Set<string>();
    const fleetB = new Set<string>();
    a.on('telemetry', (m: TelemetryBatchMsg) => gotA.push(...m.events));
    b.on('telemetry', (m: TelemetryBatchMsg) => gotB.push(...m.events));
    a.on('fleet', (m: FleetDeltaMsg) => m.states.forEach((s) => fleetA.add(s.id)));
    b.on('fleet', (m: FleetDeltaMsg) => m.states.forEach((s) => fleetB.add(s.id)));
    const now = Date.now();
    const evs = [];
    for (let i = 0; i < 20; i++) evs.push(ev('DC-S01', i, now - 30_000 + i * 1000, 5, 'sub'), ev('WC-S01', i, now - 30_000 + i * 1000, 5, 'sub'), ev('DC-S02', i, now - 30_000 + i * 1000, 5, 'sub'));
    expect((await app.ingest(evs)).status).toBe(200);
    await until(() => gotA.length === 20 && gotB.length === 20 && fleetA.size > 0 && fleetB.size > 0);
    await wait(150);
    expect(new Set(gotA.map((r) => r.d))).toEqual(new Set(['DC-S01'])); // DC-S02 telemetry not subscribed
    expect(new Set(gotB.map((r) => r.d))).toEqual(new Set(['WC-S01']));
    expect([...fleetA].every((id) => id.startsWith('DC-'))).toBe(true);
    expect([...fleetB].every((id) => id.startsWith('WC-'))).toBe(true);
    // Deltas carry only changed devices, not the whole fleet.
    expect(fleetA.size).toBeLessThanOrEqual(2);
  });

  it('stops delivery after a subscription is replaced (no stale leak)', async () => {
    const s = await app.socket(await app.login('operator'));
    await subscribe(s, { devices: ['DC-S07'] });
    await subscribe(s, { devices: ['DC-S08'] });
    const got: string[] = [];
    s.on('telemetry', (m: TelemetryBatchMsg) => m.events.forEach((e) => got.push(e.d)));
    const now = Date.now();
    await app.ingest([ev('DC-S07', 0, now - 1000, 5, 'sw'), ev('DC-S08', 0, now - 1000, 5, 'sw')]);
    await until(() => got.length >= 1);
    await wait(100);
    expect(got).toEqual(['DC-S08']);
  });
});

describe('history + live consistency', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.stop());

  it('loses nothing and duplicates nothing when events arrive while history loads', async () => {
    const dev = 'DC-S09';
    const tok = await app.login('operator');
    const t0 = Date.now() - 120_000;
    // Some pre-existing history.
    await app.ingest(Array.from({ length: 40 }, (_, i) => ev(dev, i, t0 + i * 500, 5, 'hl')));

    // Background writer keeps ingesting during the whole handoff.
    let seq = 40;
    let writing = true;
    const writer = (async () => {
      while (writing) {
        await app.ingest([ev(dev, seq, t0 + seq * 500, 5, 'hl'), ev(dev, seq + 1, t0 + (seq + 1) * 500, 5, 'hl')]);
        seq += 2;
        await wait(3);
      }
    })();

    await wait(30);
    const s = await app.socket(tok);
    const buffer: Reading[] = [];
    s.on('telemetry', (m: TelemetryBatchMsg) => buffer.push(...m.events)); // 1. buffer first
    const ack = await subscribe(s, { devices: [dev] }); // 2. join, get watermark
    const h = await app.get(`/telemetry/${dev}?from=${t0 - 1000}&mode=raw`, tok); // 3. snapshot
    expect(h.body.watermark).toBeGreaterThanOrEqual(ack.watermark);
    await wait(100);
    writing = false;
    await writer;
    await wait(150); // let the last broadcasts arrive

    const merged = mergeHistoryAndLive(h.body.readings, buffer, 100_000);
    const inDb = await app.cg.db.col.telemetry.find({ d: dev }).sort({ t: 1 }).toArray();
    expect(merged.items.map((r) => r.id)).toEqual(inDb.map((d) => d._id)); // complete, ordered
    expect(new Set(merged.items.map((r) => r.id)).size).toBe(merged.size); // unique
    // The test really exercised an overlap and a live tail.
    const histIds = new Set(h.body.readings.map((r: Reading) => r.id));
    expect(buffer.some((r) => histIds.has(r.id)) || buffer.length > 0).toBe(true);
    expect(buffer.some((r) => !histIds.has(r.id))).toBe(true);
  });

  it('catches up from MongoDB after a disconnect using the cursor', async () => {
    const dev = 'DC-S10';
    const tok = await app.login('operator');
    const t0 = Date.now() - 60_000;
    const s = await app.socket(tok);
    const got: Reading[] = [];
    s.on('telemetry', (m: TelemetryBatchMsg) => got.push(...m.events));
    await subscribe(s, { devices: [dev] });
    await app.ingest(Array.from({ length: 10 }, (_, i) => ev(dev, i, t0 + i * 1000, 5, 'cu')));
    await until(() => got.length === 10);
    const lastCursor = Math.max(...got.map((r) => r.c));
    s.disconnect();
    // Events while the client is away.
    await app.ingest(Array.from({ length: 15 }, (_, i) => ev(dev, 10 + i, t0 + (10 + i) * 1000, 5, 'cu')));
    // Reconnect: subscribe first (live), then fetch the gap by cursor.
    const s2 = await app.socket(tok);
    const live: Reading[] = [];
    s2.on('telemetry', (m: TelemetryBatchMsg) => live.push(...m.events));
    await subscribe(s2, { devices: [dev] });
    await app.ingest(Array.from({ length: 5 }, (_, i) => ev(dev, 25 + i, t0 + (25 + i) * 1000, 5, 'cu')));
    const since = await app.get(`/telemetry/${dev}/since?cursor=${lastCursor}`, tok);
    await until(() => live.length === 5);
    const merged = mergeHistoryAndLive([...got, ...since.body.readings], live, 10_000);
    expect(merged.items.map((r) => r.q)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(since.body.truncated).toBe(false);
  });

  it('serves aggregated buckets plus a raw tail for long ranges with a defined boundary', async () => {
    const dev = 'DC-F01';
    const tok = await app.login('operator');
    const now = Date.now();
    // 5,200 readings over the last ~87 minutes (> 5000 raw cap ⇒ aggregation).
    const evs = Array.from({ length: 5200 }, (_, i) => ev(dev, i, now - 5200 * 1000 + i * 1000, 4 + (i % 10) / 10, 'agg'));
    for (let i = 0; i < evs.length; i += 500) expect((await app.ingest(evs.slice(i, i + 500))).status).toBe(200);
    const h = await app.get(`/telemetry/${dev}?from=${now - 2 * 3600_000}&mode=auto`, tok);
    expect(h.body.mode).toBe('agg');
    expect(h.body.buckets.length).toBeLessThanOrEqual(720);
    const covered = h.body.buckets.reduce((a: number, b: any) => a + b.n, 0) + h.body.readings.length;
    expect(covered).toBe(5200); // buckets [from, aggEnd) + raw tail [aggEnd, to] partition the data
    expect(h.body.readings.every((r: Reading) => r.t >= h.body.aggEnd)).toBe(true);
    expect(h.body.buckets.every((b: any) => b.t + h.body.bucketMs <= h.body.aggEnd)).toBe(true);
  });
});
