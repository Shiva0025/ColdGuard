import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ev, startApp, type TestApp } from './helpers.js';

describe('tamper-evident evidence chain', () => {
  let app: TestApp;
  let op: string;
  beforeAll(async () => {
    app = await startApp();
    op = await app.login('operator');
    const t0 = Date.now() - 200_000;
    // 150 readings (3 blocks of ≤ 60), including an excursion to make a report.
    await app.ingest(Array.from({ length: 150 }, (_, i) => ev('DC-S08', i, t0 + i * 1000, i > 60 && i < 110 ? 10 : 5, 'ev')));
    await app.cg.evidence.flush();
    await app.cg.incidents.flush();
  });
  afterAll(() => app.stop());

  it('verifies an untouched chain', async () => {
    const v = (await app.get('/devices/DC-S08/evidence', op)).body;
    expect(v.ok).toBe(true);
    expect(v.totalBlocks).toBe(3);
    expect(v.readingsChecked).toBe(150);
    expect(v.unsealedTail).toBe(0);
  });

  it('pinpoints a silently altered reading and recovers after undo', async () => {
    const t = (await app.send('POST', '/demo/tamper', op, { deviceId: 'DC-S08' })).body.tampered;
    expect(t.original - t.altered).toBeCloseTo(3);
    const v = (await app.get('/devices/DC-S08/evidence', op)).body;
    expect(v.ok).toBe(false);
    expect(v.firstBreak).toMatchObject({ reason: 'reading altered', eventId: t.eventId });
    await app.send('POST', '/demo/tamper', op, { deviceId: 'DC-S08', undo: true });
    expect((await app.get('/devices/DC-S08/evidence', op)).body.ok).toBe(true);
  });

  it('detects deleted and inserted readings', async () => {
    const victim = await app.cg.db.col.telemetry.findOne({ _id: 'DC-S08:ev:70' });
    await app.cg.db.col.telemetry.deleteOne({ _id: 'DC-S08:ev:70' });
    let v = (await app.get('/devices/DC-S08/evidence', op)).body;
    expect(v.firstBreak.reason).toBe('reading missing');
    await app.cg.db.col.telemetry.insertOne(victim!);
    expect((await app.get('/devices/DC-S08/evidence', op)).body.ok).toBe(true);
    // Forge a reading inside a sealed range (fake cursor between two real ones).
    const a = await app.cg.db.col.telemetry.findOne({ _id: 'DC-S08:ev:10' });
    await app.cg.db.col.telemetry.insertOne({ ...a!, _id: 'forged', q: 9999, c: a!.c + 0.5 } as any);
    v = (await app.get('/devices/DC-S08/evidence', op)).body;
    expect(v.firstBreak.reason).toBe('extra reading');
    await app.cg.db.col.telemetry.deleteOne({ _id: 'forged' });
  });

  it('exports a report that verifies offline — and fails offline once edited', async () => {
    const inc = await app.cg.db.col.incidents.findOne({ deviceId: 'DC-S08', type: 'temp_high' });
    const rep = (await app.get(`/incidents/${inc!._id}/report`, op)).body;
    expect(rep.verification.ok).toBe(true);
    expect(rep.readings.length).toBeGreaterThan(60);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgrep-'));
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify(rep));
    const cli = path.resolve(__dirname, '../src/verifyReport.ts');
    const tsx = path.resolve(__dirname, '../../node_modules/.bin/tsx');
    expect(execFileSync(tsx, [cli, good], { encoding: 'utf8' })).toMatch(/VERIFIED/);
    rep.readings[5].tc = rep.readings[5].tc - 2; // edit the exported evidence
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify(rep));
    let out = '';
    try {
      execFileSync(tsx, [cli, bad], { encoding: 'utf8' });
    } catch (e: any) {
      out = String(e.stdout);
    }
    expect(out).toMatch(/FAILED .* reading altered/);
  });

  it('stays verifiable when the demo is reset while readings are streaming', async () => {
    let seq = 0;
    let on = true;
    const writer = (async () => {
      while (on) {
        await app.ingest([ev('DC-S09', seq, Date.now() - 60_000 + seq * 10, 5, 'rs')]);
        seq++;
      }
    })();
    await new Promise((r) => setTimeout(r, 300));
    await app.cg.resetDemo();
    await new Promise((r) => setTimeout(r, 300));
    on = false;
    await writer;
    const v = (await app.get('/devices/DC-S09/evidence', op)).body;
    expect(v.ok).toBe(true);
    expect(v.readingsChecked).toBeGreaterThan(0);
  });
});
