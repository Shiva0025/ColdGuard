import { ROOM, SubscribeSchema, type SimCommandAck, type SubscribeAck } from '@coldguard/shared';
import type { Server, Socket } from 'socket.io';
import type { AuthService, AuthUser } from './auth.js';
import type { StateEngine } from './engine.js';
import type { IngestPipeline } from './pipeline.js';
import type { SimControl } from './simControl.js';
import type { CommandManager } from './commands.js';

declare module 'socket.io' {
  interface SocketData {
    user: AuthUser;
    subs: { groups: string[]; devices: string[] };
    lagging: boolean;
    subTimes: number[];
  }
}

const SUB_RATE = { max: 20, windowMs: 10_000 };

export function attachSockets(io: Server, deps: { auth: AuthService; engine: StateEngine; pipeline: IngestPipeline; sim: SimControl; commands: CommandManager }) {
  const { auth, engine, pipeline, sim, commands } = deps;

  // ---- User namespace: authenticated via JWT in the handshake -----------
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const user = typeof token === 'string' ? auth.verify(token) : null;
    if (!user) return next(new Error('unauthenticated'));
    socket.data.user = user;
    socket.data.subs = { groups: [], devices: [] };
    socket.data.lagging = false;
    socket.data.subTimes = [];
    next();
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user;
    if (user.role === 'driver' && user.deviceId) {
      // A judge's phone: it is the "device" for commands addressed to its truck.
      const dev = user.deviceId;
      socket.join(`driver:${dev}`);
      socket.on('command:ack', (a: SimCommandAck) => {
        if (a && typeof a.id === 'string' && a.deviceId === dev) commands.onAck(a);
      });
      setTimeout(() => commands.redeliver(dev), 200);
    } else {
      socket.join(ROOM.platform);
      for (const g of user.groups) socket.join(ROOM.groupAlerts(g));
    }

    /**
     * Replace this socket's subscriptions. Rooms are joined BEFORE the
     * watermark is read, so any event committed after `watermark` will be
     * delivered to this socket; anything at or below it is in MongoDB.
     */
    socket.on('subscribe', (raw: unknown, ack?: (a: SubscribeAck) => void) => {
      const reply = (a: Partial<SubscribeAck>) =>
        typeof ack === 'function' &&
        ack({ ok: false, groups: socket.data.subs.groups, devices: socket.data.subs.devices, watermark: pipeline.committed, serverTime: Date.now(), ...a });

      const now = Date.now();
      socket.data.subTimes = socket.data.subTimes.filter((t: number) => now - t < SUB_RATE.windowMs);
      if (socket.data.subTimes.length >= SUB_RATE.max) return reply({ error: 'subscription rate limit' });
      socket.data.subTimes.push(now);

      const parsed = SubscribeSchema.safeParse(raw);
      if (!parsed.success) return reply({ error: 'invalid subscription' });
      const allowed = new Set(user.groups);
      const groups = [...new Set(parsed.data.groups)];
      const devices = [...new Set(parsed.data.devices)];
      const badGroup = groups.find((g) => !allowed.has(g));
      if (badGroup) return reply({ error: `not authorised for group ${badGroup}` });
      for (const d of devices) {
        const info = engine.device(d);
        if (!info) return reply({ error: `unknown device ${d}` });
        const ok = user.deviceId ? d === user.deviceId : allowed.has(info.groupId);
        if (!ok) return reply({ error: `not authorised for device ${d}` });
      }

      for (const g of socket.data.subs.groups) if (!groups.includes(g)) socket.leave(ROOM.group(g));
      for (const d of socket.data.subs.devices) if (!devices.includes(d)) socket.leave(ROOM.device(d));
      for (const g of groups) socket.join(ROOM.group(g));
      for (const d of devices) socket.join(ROOM.device(d));
      socket.data.subs = { groups, devices };
      reply({ ok: true, groups, devices, watermark: pipeline.committed, serverTime: Date.now(), error: undefined });
    });

    // NTP-style clock probe: client computes offset = serverTime - (t0 + t1) / 2.
    socket.on('clock', (ack?: (serverTime: number) => void) => {
      if (typeof ack === 'function') ack(Date.now());
    });
  });

  // ---- Agent namespace: simulator control plane ---------------------------
  const agentNs = io.of('/agent');
  agentNs.use(async (socket, next) => {
    const agent = await auth.verifyAgentKey(socket.handshake.auth?.key).catch(() => null);
    if (!agent) return next(new Error('invalid agent credential'));
    socket.data.user = { username: agent.agentId, role: 'viewer', displayName: agent.agentId, groups: agent.groups };
    next();
  });
  sim.attach(agentNs);
}
