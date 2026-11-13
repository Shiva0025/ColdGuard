import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Incident, IncidentType } from '@coldguard/shared';
import { ev, startApp, subscribe, until, wait, type TestApp } from './helpers.js';

const RULES = {
  tempLowC: 2,
  tempHighC: 8,
  sustainSec: 10,
  hysteresisC: 0.5,
  recoverySec: 10,
  driftCPerMin: 1.5,
  driftWindowSec: 60,
  offlineSec: 5,
  lowBatteryPct: 15,
  exposureBudgetCMin: 5,
};

describe('incident detection, dedupe, acknowledgement and recovery', () => {
  let app: TestApp;
  let op: string;
  beforeAll(async () => {
    app = await startApp();
    op = await app.login('operator');
    expect((await app.send('PUT', '/rules', op, RULES)).status).toBe(200);
  });
  afterAll(() => app.stop());

  const active = (dev: string, type: IncidentType) => app.cg.db.col.incidents.find({ deviceId: dev, type, active: true }).toArray();

  it('does not alert on a brief (unsustained) breach', async () => {
    const t0 = Date.now() - 100_000;
    const temps = [5, 5, 8.6, 8.9, 8.7, 7.0, 5, 5]; // 3 s above limit, rule needs 10 s
    await app.ingest(temps.map((tc, i) => ev('DC-S01', i, t0 + i * 1000, tc, 'brief')));
    await app.cg.incidents.flush();
    expect(await active('DC-S01', 'temp_high')).toHaveLength(0);
  });

  it('opens one explained incident for a sustained breach and deduplicates further breaches', async () => {
    const s = await app.socket(op);
    const pushed: Incident[] = [];
    s.on('incident', (i: Incident) => pushed.push(i));
    await subscribe(s, { groups: ['deccan'] });

    const t0 = Date.now() - 90_000;
    const temps = [5, 6, 8.4, 8.8, 9.1, 9.3, 9.6, 9.8, 10.1, 10.2, 10.4, 10.6, 10.9, 11.0, 11.2, 11.1, 11.3, 11.0];
    await app.ingest(temps.map((tc, i) => ev('DC-S02', i, t0 + i * 1000, tc, 'exc')));
    await app.cg.incidents.flush();
    const inc = await active('DC-S02', 'temp_high');
    expect(inc).toHaveLength(1);
    const i = inc[0];
    expect(i.severity).toBe('critical');
    expect(i.openedAt).toBe(t0 + 2000); // first breaching reading
    expect(i.triggeredAt).toBe(t0 + 12000); // 10 s later
    expect(i.explanation).toMatch(/above 8\.0 °C for 10 s/);
    expect(i.explanation).toMatch(/First breach 8\.40 °C/);
    expect(i.evidence.first?.eventId).toBe('DC-S02:exc:2');

    // More breaching readings: still exactly one active incident.
    await app.ingest([12, 12.5, 12.2].map((tc, k) => ev('DC-S02', 18 + k, t0 + (18 + k) * 1000, tc, 'exc')));
    await app.cg.incidents.flush();
    expect(await active('DC-S02', 'temp_high')).toHaveLength(1);
    expect(app.cg.engine.state('DC-S02')!.status).toBe('critical');
    await until(() => pushed.some((p) => p.deviceId === 'DC-S02' && p.type === 'temp_high'));
  });

  it('the partial unique index rejects a second active incident at the database boundary', async () => {
    const [i] = await active('DC-S02', 'temp_high');
    const { _id, ...rest } = i;
    await expect(app.cg.db.col.incidents.insertOne({ ...rest, _id: 'dup-attempt' })).rejects.toMatchObject({ code: 11000 });
  });

  it('only operators can acknowledge; ack records user and time', async () => {
    const [i] = await active('DC-S02', 'temp_high');
    const viewer = await app.login('viewer.deccan');
    expect((await app.send('POST', `/incidents/${i._id}/ack`, viewer, {})).status).toBe(403);
    const r = await app.send('POST', `/incidents/${i._id}/ack`, op, { note: 'moved to backup reefer' });
    expect(r.status).toBe(200);
    expect(r.body.incident.state).toBe('acknowledged');
    expect(r.body.incident.ack).toMatchObject({ by: 'operator', note: 'moved to backup reefer' });
    expect((await app.send('POST', `/incidents/${i._id}/ack`, op, {})).status).toBe(409);
    const western = await app.login('viewer.western');
    void western;
  });

  it('recovers only after staying inside the hysteresis band for the recovery time (no flicker)', async () => {
    const t0 = Date.now() - 90_000 + 21_000;
    // Dip just below the limit but inside the hysteresis band (7.8 > 8 − 0.5): must not start recovery.
    await app.ingest([7.8, 7.9, 7.7].map((tc, k) => ev('DC-S02', 21 + k, t0 + k * 1000, tc, 'exc')));
    await app.cg.incidents.flush();
    let [i] = await active('DC-S02', 'temp_high');
    expect(i.recoveringSince ?? null).toBeNull();
    // Inside band for 5 s, then a relapse: recovery restarts.
    const seqBase = 24;
    const temps = [7, 6.5, 6, 5.8, 5.6, 5.5, 9.0];
    await app.ingest(temps.map((tc, k) => ev('DC-S02', seqBase + k, t0 + (3 + k) * 1000, tc, 'exc')));
    await app.cg.incidents.flush();
    [i] = await active('DC-S02', 'temp_high');
    expect(i).toBeDefined();
    expect(i.timeline.some((e) => e.kind === 'relapse')).toBe(true);
    // Now 11 s continuously inside the band ⇒ resolved.
    const calm = Array.from({ length: 12 }, (_, k) => ev('DC-S02', seqBase + 7 + k, t0 + (10 + k) * 1000, 5.5, 'exc'));
    await app.ingest(calm);
    await app.cg.incidents.flush();
    expect(await active('DC-S02', 'temp_high')).toHaveLength(0);
    const resolved = await app.cg.db.col.incidents.findOne({ deviceId: 'DC-S02', type: 'temp_high' });
    expect(resolved?.state).toBe('resolved');
    expect(resolved?.ack?.by).toBe('operator');
  });

  it('a late (out-of-order) reading never re-opens or resets alert state', async () => {
    const before = await app.cg.db.col.incidents.countDocuments({ deviceId: 'DC-S02' });
    // An old, very hot reading from earlier in the session arrives late.
    await app.ingest([{ ...ev('DC-S02', 5, Date.now() - 89_000, 30, 'exc'), eventId: 'late-dup-attempt' }]);
    await app.ingest([ev('DC-S02', 1000, Date.now() - 88_000, 30, 'exc-late')]); // older observedAt, other session ⇒ late
    await app.cg.incidents.flush();
    expect(await app.cg.db.col.incidents.countDocuments({ deviceId: 'DC-S02' })).toBe(before);
    expect(app.cg.engine.state('DC-S02')!.tc).toBe(5.5);
  });

  it('raises an early drift warning before the threshold is crossed', async () => {
    const t0 = Date.now() - 80_000;
    // 3 °C/min rise from 4 °C: stays below 8 °C for the first 60 s.
    const evs = Array.from({ length: 40 }, (_, i) => ev('DC-S03', i, t0 + i * 1000, 4 + (i * 3) / 60, 'drift', { cooling: 'fault' }));
    await app.ingest(evs);
    await app.cg.incidents.flush();
    const [d] = await active('DC-S03', 'rapid_drift');
    expect(d).toBeDefined();
    expect(d.evidence.trigger!.tc).toBeLessThan(8);
    expect(d.explanation).toMatch(/rising at 3\.0\d? °C\/min|rising at 2\.9\d °C\/min|rising at 3\.\d+ °C\/min/);
  });

  it('detects sensor-offline from the server clock and resolves when data resumes', async () => {
    await app.ingest([ev('DC-S04', 0, Date.now() - 1000, 5, 'off')]);
    await wait(6500); // offlineSec = 5
    await until(async () => (await active('DC-S04', 'sensor_offline')).length === 1, 4000);
    expect(app.cg.engine.state('DC-S04')!.status).toBe('offline');
    await app.ingest([ev('DC-S04', 1, Date.now(), 5, 'off')]);
    await app.cg.incidents.flush();
    expect(await active('DC-S04', 'sensor_offline')).toHaveLength(0);
    expect(app.cg.engine.state('DC-S04')!.status).not.toBe('offline');
  });

  it('opens and clears a low battery warning with hysteresis', async () => {
    const t = Date.now() - 10_000;
    await app.ingest([ev('DC-S05', 0, t, 5, 'bat', { batteryPct: 12 })]);
    await app.cg.incidents.flush();
    expect(await active('DC-S05', 'low_battery')).toHaveLength(1);
    await app.ingest([ev('DC-S05', 1, t + 1000, 5, 'bat', { batteryPct: 17 })]); // < 15 + 5: still low
    await app.cg.incidents.flush();
    expect(await active('DC-S05', 'low_battery')).toHaveLength(1);
    await app.ingest([ev('DC-S05', 2, t + 2000, 5, 'bat', { batteryPct: 40 })]);
    await app.cg.incidents.flush();
    expect(await active('DC-S05', 'low_battery')).toHaveLength(0);
  });

  it('integrates heat exposure and raises a budget incident; recovery does not refund the budget', async () => {
    const t0 = Date.now() - 400_000; // keep every reading inside the +30 s clock-skew window
    // 200 s at 10.5 °C = 2.5 °C above the limit ⇒ 2.5 × 199/60 ≈ 8.29 °C·min (trapezoid over 199 intervals).
    await app.ingest(Array.from({ length: 200 }, (_, i) => ev('DC-S07', i, t0 + i * 1000, 10.5, 'exp')));
    await app.cg.incidents.flush();
    const st = app.cg.engine.state('DC-S07')!;
    expect(st.exposure).toBeCloseTo((2.5 * 199) / 60, 2);
    const [inc] = await active('DC-S07', 'exposure_budget');
    expect(inc.explanation).toMatch(/exhausting the 5 °C·min demo budget/);
    // A 2-minute data gap is NOT integrated (unknown, not assumed).
    await app.ingest([ev('DC-S07', 200, t0 + 320_000, 10.5, 'exp')]);
    expect(app.cg.engine.state('DC-S07')!.exposure).toBeCloseTo((2.5 * 199) / 60, 2);
    // Back in band for the recovery time ⇒ incident resolves, exposure stays spent.
    await app.ingest(Array.from({ length: 15 }, (_, i) => ev('DC-S07', 201 + i, t0 + 321_000 + i * 1000, 5, 'exp')));
    await app.cg.incidents.flush();
    expect(await active('DC-S07', 'exposure_budget')).toHaveLength(0);
    expect(app.cg.engine.state('DC-S07')!.exposure).toBeGreaterThan(8);
    expect(app.cg.engine.state('DC-S07')!.reasons.join(' ')).toMatch(/Heat budget spent/);
  });
});
