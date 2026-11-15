import { describe, expect, it } from 'vitest';
import { TunnelManager } from '../src/tunnel.js';
import { ev, startApp, until, wait } from './helpers.js';

describe('server restart against an existing database', () => {
  it('does not open a "sensor offline" incident for devices that were silent across the downtime', async () => {
    const dbName = `coldguard_test_restart_${Date.now().toString(36)}`;
    const a = await startApp({}, { dbName, keepDb: true });
    expect((await a.ingest([ev('DC-S01', 0, Date.now() - 1000, 5, 'r1'), ev('DC-S02', 0, Date.now() - 1000, 5, 'r1')])).status).toBe(200);
    await until(() => a.cg.engine.state('DC-S01')?.status === 'healthy');
    const col = a.cg.db.col;
    await a.stop(); // persists device state, keeps the database

    // Simulate hours of downtime: the last reading was received 3 h ago.
    const { MongoClient } = await import('mongodb');
    const c = new MongoClient(a.cg.cfg.MONGO_URL);
    await c.connect();
    const old = Date.now() - 3 * 3600_000;
    const r = await c.db().collection<any>(col.deviceState.collectionName).updateMany({ _id: { $in: ['DC-S01', 'DC-S02'] } }, { $set: { 'snapshot.r': old } });
    expect(r.modifiedCount).toBe(2);
    await c.close();

    const b = await startApp({}, { dbName });
    try {
      const op = await b.login('operator');
      await wait(2500); // several offline ticks
      expect(await b.cg.db.col.incidents.countDocuments({ type: 'sensor_offline' })).toBe(0);
      expect(b.cg.engine.state('DC-S01')?.status).toBe('offline');

      // Telemetry resumes: the device goes straight back to healthy, still with no incident.
      expect((await b.ingest([ev('DC-S01', 1, Date.now() - 500, 5, 'r1')])).status).toBe(200);
      await until(() => b.cg.engine.state('DC-S01')?.status === 'healthy');
      await b.cg.incidents.flush();
      expect(await b.cg.db.col.incidents.countDocuments({ type: 'sensor_offline' })).toBe(0);
      expect((await b.get('/devices/DC-S01', op)).body.state.status).toBe('healthy');
    } finally {
      await b.stop();
    }
  });
});

describe('public tunnel for judges', () => {
  const fake = (script: string) => new TunnelManager([{ name: 'missing', cmd: 'coldguard-no-such-tool', args: () => [], url: /x/ }, { name: 'fake', cmd: process.execPath, args: (t) => ['-e', script, t], url: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/ }], 5000);

  it('falls through missing tools, reports the public URL, and is operator-only', async () => {
    const tunnel = fake(`console.error('INF target ' + process.argv[1] + ' https://demo-abc.trycloudflare.com'); setInterval(() => {}, 1000)`);
    const app = await startApp({}, { tunnel });
    try {
      const op = await app.login('operator');
      const viewer = await app.login('viewer.deccan');
      expect((await app.send('POST', '/guest/tunnel', viewer, {})).status).toBe(403);
      const r = await app.send('POST', '/guest/tunnel', op, { port: 22 }); // arbitrary ports are not exposed
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'on', url: 'https://demo-abc.trycloudflare.com', provider: 'fake' });
      expect((await app.get('/guest/status', op)).body.tunnel.url).toBe('https://demo-abc.trycloudflare.com');
      expect((await app.send('DELETE', '/guest/tunnel', op)).body.status).toBe('off');
    } finally {
      await app.stop();
    }
  });

  it('explains the failure when no tool can open a tunnel', async () => {
    const t = fake(`console.error('ERR authentication failed'); process.exit(1)`);
    const st = await t.start('http://localhost:5173');
    expect(st.status).toBe('off');
    expect(st.error).toMatch(/missing: not installed/);
    expect(st.error).toMatch(/authentication failed/);
  });
});
