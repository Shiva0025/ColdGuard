import { ROOM, type Command, type FleetDeltaMsg, type Incident, type Reading, type TelemetryBatchMsg } from '@coldguard/shared';
import type { Server } from 'socket.io';
import type { StateEngine } from './engine.js';
import { RateCounter, Reservoir } from './metrics.js';

/**
 * Selective, batched fan-out.
 *  - `device:<id>` rooms receive raw readings for that device, coalesced every TELEMETRY_EMIT_MS.
 *  - `group:<id>` rooms receive only the *changed* device states (latest version per device)
 *    every FLEET_EMIT_MS — never the whole fleet.
 *  - `alerts:<group>` rooms receive incident transitions immediately.
 * Buffers are only filled for rooms that currently have members, so unwatched
 * devices cost nothing beyond persistence.
 *
 * Slow consumers: a socket whose engine.io write buffer exceeds
 * SLOW_CLIENT_PACKETS is moved into the `lagging` room and excluded from
 * broadcasts (bounded server memory). When its buffer drains it receives
 * `resync` and re-fetches from MongoDB using its cursor.
 */
export class Broadcaster {
  private deviceBuf = new Map<string, Reading[]>();
  private timers: NodeJS.Timeout[] = [];
  readonly pipelineMs = new Reservoir(4096);
  readonly emitted = new RateCounter();
  laggingCount = 0;
  private static MAX_DEVICE_BUF = 5000;

  constructor(
    private io: Server,
    private engine: StateEngine,
    private opts: { telemetryEmitMs: number; fleetEmitMs: number; slowClientPackets: number },
  ) {}

  start() {
    this.timers.push(setInterval(() => this.flushTelemetry(), this.opts.telemetryEmitMs));
    this.timers.push(setInterval(() => this.flushFleet(), this.opts.fleetEmitMs));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private hasMembers(room: string) {
    const r = this.io.of('/').adapter.rooms.get(room);
    return !!r && r.size > 0;
  }

  onPersisted(readings: Reading[]) {
    for (const r of readings) {
      const room = ROOM.device(r.d);
      if (!this.hasMembers(room)) continue;
      let b = this.deviceBuf.get(r.d);
      if (!b) this.deviceBuf.set(r.d, (b = []));
      if (b.length < Broadcaster.MAX_DEVICE_BUF) b.push(r);
    }
  }

  onIncident(i: Incident) {
    this.io.to(ROOM.groupAlerts(i.groupId)).emit('incident', i);
  }

  onCommand(c: Command) {
    this.io.to(ROOM.groupAlerts(c.groupId)).emit('command', c);
  }

  flushTelemetry() {
    this.updateLagging();
    if (this.deviceBuf.size === 0) return;
    const st = Date.now();
    for (const [deviceId, events] of this.deviceBuf) {
      const room = ROOM.device(deviceId);
      const msg: TelemetryBatchMsg = { st, events };
      this.io.to(room).except(ROOM.lagging).emit('telemetry', msg);
      const n = this.io.of('/').adapter.rooms.get(room)?.size ?? 0;
      this.emitted.add(events.length * n);
      for (const e of events) this.pipelineMs.add(st - e.r);
    }
    this.deviceBuf.clear();
  }

  flushFleet() {
    const dirty = this.engine.takeDirty();
    const st = Date.now();
    for (const [groupId, ids] of dirty) {
      const room = ROOM.group(groupId);
      if (!this.hasMembers(room)) continue;
      const states = [...ids].map((id) => this.engine.state(id)!).filter(Boolean);
      const msg: FleetDeltaMsg = { st, states };
      this.io.to(room).except(ROOM.lagging).emit('fleet', msg);
      this.emitted.add(states.length * (this.io.of('/').adapter.rooms.get(room)?.size ?? 0));
    }
  }

  private updateLagging() {
    let lagging = 0;
    for (const s of this.io.of('/').sockets.values()) {
      const buf: number = (s.conn as any)?.writeBuffer?.length ?? 0;
      if (!s.data.lagging && buf > this.opts.slowClientPackets) {
        s.data.lagging = true;
        s.join(ROOM.lagging);
      } else if (s.data.lagging && buf === 0) {
        s.data.lagging = false;
        s.leave(ROOM.lagging);
        s.emit('resync', { reason: 'slow-consumer' });
      }
      if (s.data.lagging) lagging++;
    }
    this.laggingCount = lagging;
  }
}
