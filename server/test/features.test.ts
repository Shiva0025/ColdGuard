import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ev, startApp, type TestApp } from './helpers.js';

describe('forecast, CSV export and response analytics', () => {
  let app: TestApp;
  let op: string;
  let western: string;
  beforeAll(async () => {
    app = await startApp();
    op = await app.login('operator');
    western = await app.login('viewer.western');
  });
  afterAll(() => app.stop());

  it('forecasts time-to-breach while in range and trending out, and clears it when the trend stops', async () => {
    const t0 = Date.now() - 300_000;
    // 1.2 °C/min: above half the drift threshold (0.75) but below the drift alert (1.5).
    const rising = Array.from({ length: 41 }, (_, i) => ev('DC-S03', i, t0 + i * 1000, Math.round((6 + i * 0.02) * 100) / 100, 'fc'));
    expect((await app.ingest(rising)).status).toBe(200);
    const a = (await app.get('/devices/DC-S03', op)).body.state;
    expect(a.eta).toBeTruthy();
    expect(a.eta.limit).toBe('high');
    expect(a.eta.limitC).toBe(8);
    expect(a.eta.slopeCPerMin).toBeGreaterThan(1.1);
    expect(a.eta.slopeCPerMin).toBeLessThan(1.3);
    // (8 − 6.8) / 1.2 °C/min ≈ 60 s
    expect(a.eta.sec).toBeGreaterThan(48);
    expect(a.eta.sec).toBeLessThan(75);
    expect(a.status).toBe('warning');
    expect(a.reasons.join(' ')).toMatch(/to 8 °C at current rate/);
    expect(await app.cg.db.col.incidents.countDocuments({ deviceId: 'DC-S03' })).toBe(0); // a forecast is not an alert

    // The same slope in the middle of the band (normal compressor cycling) is not forecast.
    const mid = Array.from({ length: 41 }, (_, i) => ev('DC-S06', i, t0 + i * 1000, Math.round((5.6 - i * 0.02) * 100) / 100, 'fc'));
    expect((await app.ingest(mid)).status).toBe(200);
    const m = (await app.get('/devices/DC-S06', op)).body.state;
    expect(m.eta ?? null).toBeNull();
    expect(m.status).toBe('healthy');

    // Temperature holds steady for longer than the drift window: no forecast.
    const flat = Array.from({ length: 70 }, (_, i) => ev('DC-S03', 41 + i, t0 + (41 + i) * 1000, 6.8, 'fc'));
    expect((await app.ingest(flat)).status).toBe(200);
    const b = (await app.get('/devices/DC-S03', op)).body.state;
    expect(b.eta ?? null).toBeNull();
    expect(b.status).toBe('healthy');
  });

  it('exports stored readings as CSV, scoped to the user’s corridors', async () => {
    const t0 = Date.now() - 120_000;
    await app.ingest(Array.from({ length: 12 }, (_, i) => ev('DC-S04', i, t0 + i * 1000, 5 + i / 100, 'csv', { doorOpen: i === 3 })));
    const url = `${app.url}/api/telemetry/DC-S04/export.csv?from=${t0 - 1000}&to=${t0 + 60_000}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${op}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('x-truncated')).toBe('0');
    const lines = (await res.text()).trim().split('\n');
    expect(lines[0]).toBe('eventId,deviceId,sessionId,seq,observedAt,receivedAt,tempC,humidityPct,batteryPct,cooling,doorOpen,routeProgress,late,commitCursor');
    expect(lines).toHaveLength(13);
    const row3 = lines[4].split(',');
    expect(row3[0]).toBe('DC-S04:csv:3');
    expect(row3[4]).toBe(new Date(t0 + 3000).toISOString());
    expect(Number(row3[6])).toBe(5.03);
    expect(row3[9]).toBe('on');
    expect(row3[10]).toBe('1');

    expect((await fetch(url, { headers: { authorization: `Bearer ${western}` } })).status).toBe(404);
    expect((await fetch(url)).status).toBe(401);
  });

  it('reports acknowledgement and resolution times per corridor', async () => {
    const before = (await app.get('/analytics/incidents?hours=1', op)).body;
    expect(before.overall.total).toBe(0);
    expect(before.overall.medianAckSec).toBeNull();

    const t0 = Date.now() - 200_000;
    // 40 s above 8 °C (default rule: 20 s sustained) → one critical incident triggered at t0 + 20 s.
    await app.ingest(Array.from({ length: 41 }, (_, i) => ev('DC-S05', i, t0 + i * 1000, 9.5, 'an')));
    await app.cg.incidents.flush();
    const inc = await app.cg.db.col.incidents.findOne({ deviceId: 'DC-S05', type: 'temp_high' });
    expect(inc).toBeTruthy();
    expect((await app.send('POST', `/incidents/${inc!._id}/ack`, op, { note: 'checking' })).status).toBe(200);

    const a = (await app.get('/analytics/incidents?hours=1', op)).body;
    expect(a.overall.total).toBeGreaterThanOrEqual(1);
    expect(a.overall.acknowledged).toBe(1);
    expect(a.overall.unacknowledged).toBe(a.overall.active - 1);
    // triggered ≈ 180 s ago on the device clock, acknowledged now
    expect(a.overall.medianAckSec).toBeGreaterThan(150);
    expect(a.overall.medianAckSec).toBeLessThan(240);
    const high = a.byType.find((t: { key: string }) => t.key === 'temp_high');
    expect(high.total).toBe(1);
    expect(high.critical).toBe(1);
    expect(a.byGroup.map((g: { key: string }) => g.key)).toEqual(['deccan']);
    expect(a.topDevices[0].key).toBe('DC-S05');

    // Back in range for the recovery time → resolved, and a resolution time appears.
    await app.ingest(Array.from({ length: 40 }, (_, i) => ev('DC-S05', 41 + i, t0 + (41 + i) * 1000, 5, 'an')));
    await app.cg.incidents.flush();
    const r = (await app.get('/analytics/incidents?hours=1', op)).body;
    const high2 = r.byType.find((t: { key: string }) => t.key === 'temp_high');
    expect(high2.resolved).toBe(1);
    expect(high2.medianResolveSec).toBeGreaterThan(20);
    expect(high2.medianResolveSec).toBeLessThan(60);

    // Another corridor's viewer sees none of it.
    expect((await app.get('/analytics/incidents?hours=1', western)).body.overall.total).toBe(0);
    expect((await app.get('/analytics/incidents', '')).status).toBe(401);
  });
});
