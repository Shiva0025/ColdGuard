import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Command, SimCommandAck, SimCommandMsg } from '@coldguard/shared';
import { ev, startApp, subscribe, until, type TestApp } from './helpers.js';

describe('judges join by QR: phone trucks', () => {
  let app: TestApp;
  let op: string;
  let code: string;
  beforeAll(async () => {
    app = await startApp();
    op = await app.login('operator');
    code = (await app.send('POST', '/guest/invite', op, { ttlMin: 5 })).body.invite.code;
  });
  afterAll(() => app.stop());

  const claim = (name: string, c = code) =>
    fetch(`${app.url}/api/guest/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c, name }) }).then(async (r) => ({ status: r.status, body: await r.json() }));

  it('only operators can create invites; a bad code is refused', async () => {
    const viewer = await app.login('viewer.deccan');
    expect((await app.send('POST', '/guest/invite', viewer, {})).status).toBe(403);
    expect((await claim('Mallory', 'WRONGCODE')).status).toBe(403);
    expect((await claim('<script>')).status).toBe(400);
  });

  it('assigns distinct trucks and scopes each phone to its own truck', async () => {
    const a = await claim('Asha');
    const b = await claim('Ravi');
    expect(a.status).toBe(200);
    expect(a.body.device.id).not.toBe(b.body.device.id);
    expect(a.body.device.name).toBe("Asha's truck");
    const tokA = a.body.token;
    const devA = a.body.device.id;
    const devB = b.body.device.id;

    // Ingest with the driver token: own truck accepted, someone else's truck rejected.
    const post = (events: unknown[]) =>
      fetch(`${app.url}/api/ingest/batch`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokA}` }, body: JSON.stringify({ events }) }).then((r) => r.json());
    const r = await post([ev(devA, 0, Date.now() - 1000, 5, 'ph'), ev(devB, 0, Date.now() - 1000, 5, 'ph'), ev('DC-S01', 0, Date.now() - 1000, 5, 'ph')]);
    expect(r.persisted).toBe(1);
    expect(r.rejected.map((x: any) => x.reason)).toEqual(['agent not authorised for device', 'agent not authorised for device']);

    // Visibility: only its own truck.
    expect((await app.get(`/devices/${devA}`, tokA)).status).toBe(200);
    expect((await app.get(`/devices/${devB}`, tokA)).status).toBe(404);
    expect((await app.get('/fleet', tokA)).body.devices.map((d: any) => d.id)).toEqual([devA]);
    expect((await app.send('POST', `/devices/${devA}/commands`, tokA, { kind: 'close_door' })).status).toBe(403);
    expect((await app.send('POST', '/guest/invite', tokA, {})).status).toBe(403);
    const s = await app.socket(tokA);
    expect((await subscribe(s, { devices: [devB] })).ok).toBe(false);
    expect((await subscribe(s, { groups: ['guest'] })).ok).toBe(false);
  });

  it('routes operator commands for a phone truck to that phone and completes the lifecycle', async () => {
    const c = await claim('Meera');
    const dev = c.body.device.id;
    const phone = await app.socket(c.body.token);
    phone.on('command', (cmd: SimCommandMsg, ack: (a: SimCommandAck) => void) => {
      ack({ id: cmd.id, deviceId: cmd.deviceId, phase: 'delivered' });
      phone.emit('command:ack', { id: cmd.id, deviceId: cmd.deviceId, phase: 'applied', appliedAt: Date.now() });
    });
    await app.ingest([ev(dev, 0, Date.now() - 2000, 7, 'phc', { doorOpen: true })]);
    const r = await app.send('POST', `/devices/${dev}/commands`, op, { kind: 'close_door' });
    expect(r.status).toBe(202);
    const id = r.body.command.id;
    const get = async (): Promise<Command | undefined> => (await app.get(`/devices/${dev}/commands`, op)).body.commands.find((x: Command) => x.id === id);
    await until(async () => (await get())?.state === 'acknowledged');
    const fetchPost = (events: unknown[]) =>
      fetch(`${app.url}/api/ingest/batch`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.body.token}` }, body: JSON.stringify({ events }) });
    await fetchPost([ev(dev, 1, Date.now(), 7, 'phc', { doorOpen: false })]);
    await until(async () => (await get())?.state === 'effect_observed');
  });

  it('release frees the trucks and invalidates the invite', async () => {
    expect((await app.send('POST', '/guest/release', op)).status).toBe(200);
    expect((await claim('Late')).status).toBe(403);
  });
});
