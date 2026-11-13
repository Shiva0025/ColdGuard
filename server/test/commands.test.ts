import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ioc, type Socket } from 'socket.io-client';
import type { Command, SimCommandAck, SimCommandMsg } from '@coldguard/shared';
import { AGENT_KEY, ev, startApp, until, type TestApp } from './helpers.js';

describe('operator commands: requested → delivered → acknowledged → effect observed', () => {
  let app: TestApp;
  let op: string;
  let agent: Socket;
  const offline = new Set<string>();
  const queued: SimCommandMsg[] = [];

  beforeAll(async () => {
    app = await startApp();
    op = await app.login('operator');
    // A minimal agent on the real /agent namespace (stands in for the simulator process).
    agent = ioc(`${app.url}/agent`, { auth: { key: AGENT_KEY }, transports: ['websocket'], forceNew: true });
    await new Promise<void>((r) => agent.once('connect', () => r()));
    agent.on('command', (cmd: SimCommandMsg, ack: (a: SimCommandAck) => void) => {
      const isOff = offline.has(cmd.deviceId);
      ack({ id: cmd.id, deviceId: cmd.deviceId, phase: 'delivered', queuedOffline: isOff });
      if (isOff) queued.push(cmd);
      else agent.emit('command:ack', { id: cmd.id, deviceId: cmd.deviceId, phase: 'applied', appliedAt: Date.now(), counterfactual: [[Date.now(), 9], [Date.now() + 60_000, 12]], horizonSec: 60 });
    });
  });
  afterAll(async () => {
    agent.disconnect();
    await app.stop();
  });

  const get = async (dev: string): Promise<Command[]> => (await app.get(`/devices/${dev}/commands`, op)).body.commands;

  it('only operators may issue commands, and payloads are validated', async () => {
    const viewer = await app.login('viewer.deccan');
    expect((await app.send('POST', '/devices/DC-S01/commands', viewer, { kind: 'close_door' })).status).toBe(403);
    expect((await app.send('POST', '/devices/DC-S01/commands', op, { kind: 'launch_rocket' })).status).toBe(400);
    expect((await app.send('POST', '/devices/NOPE/commands', op, { kind: 'close_door' })).status).toBe(404);
  });

  it('confirms the effect only from telemetry, not from the simulator’s word', async () => {
    const t0 = Date.now() - 20_000;
    await app.ingest([ev('DC-S02', 0, t0, 9.5, 'cmd', { cooling: 'fault' })]);
    const r = await app.send('POST', '/devices/DC-S02/commands', op, { kind: 'backup_cooling' });
    expect(r.status).toBe(202);
    const id = r.body.command.id;
    await until(async () => (await get('DC-S02')).find((c) => c.id === id)?.state === 'acknowledged');
    const acked = (await get('DC-S02')).find((c) => c.id === id)!;
    expect(acked.deliveredAt).toBeDefined();
    expect(acked.counterfactual?.points.length).toBe(2);
    expect(acked.baseline?.tc).toBe(9.5);

    // A reading that does NOT show the effect (still faulted, not cooler).
    await app.ingest([ev('DC-S02', 1, Date.now(), 9.6, 'cmd', { cooling: 'fault' })]);
    await app.cg.commands.flush();
    expect((await get('DC-S02')).find((c) => c.id === id)!.state).toBe('acknowledged');

    // Backup running and 0.5 °C cooler ⇒ effect observed.
    await app.ingest([ev('DC-S02', 2, Date.now() + 1, 9.0, 'cmd', { cooling: 'backup' })]);
    await until(async () => (await get('DC-S02')).find((c) => c.id === id)?.state === 'effect_observed');
    const done = (await get('DC-S02')).find((c) => c.id === id)!;
    expect(done.effect?.eventId).toBe('DC-S02:cmd:2');
    expect(done.timeline.map((x) => x.state)).toEqual(['requested', 'delivered', 'acknowledged', 'effect_observed']);
  });

  it('shows a command as queued while the truck is offline and completes it after reconnect', async () => {
    offline.add('DC-S03');
    await app.ingest([ev('DC-S03', 0, Date.now() - 5000, 7, 'q', { doorOpen: true })]);
    const r = await app.send('POST', '/devices/DC-S03/commands', op, { kind: 'close_door' });
    const id = r.body.command.id;
    await until(async () => (await get('DC-S03')).find((c) => c.id === id)?.state === 'delivered');
    expect((await get('DC-S03')).find((c) => c.id === id)!.queuedOffline).toBe(true);
    // Reconnect: the device applies the queued command, and its next reading shows the door closed.
    offline.delete('DC-S03');
    const cmd = queued.pop()!;
    agent.emit('command:ack', { id: cmd.id, deviceId: cmd.deviceId, phase: 'applied', appliedAt: Date.now() });
    await until(async () => (await get('DC-S03')).find((c) => c.id === id)?.state === 'acknowledged');
    await app.ingest([ev('DC-S03', 1, Date.now() + 1, 7.1, 'q', { doorOpen: false })]);
    await until(async () => (await get('DC-S03')).find((c) => c.id === id)?.state === 'effect_observed');
  });

  it('records the action on the linked incident timeline', async () => {
    const t0 = Date.now() - 60_000;
    await app.ingest(Array.from({ length: 25 }, (_, i) => ev('DC-S04', i, t0 + i * 1000, 10, 'inc')));
    await app.cg.incidents.flush();
    const inc = await app.cg.db.col.incidents.findOne({ deviceId: 'DC-S04', type: 'temp_high', active: true });
    expect(inc).toBeTruthy();
    await app.send('POST', '/devices/DC-S04/commands', op, { kind: 'restore_cooling', incidentId: inc!._id });
    await until(async () => !!(await app.cg.db.col.incidents.findOne({ _id: inc!._id }))?.timeline.some((e) => e.kind === 'action'));
  });
});
