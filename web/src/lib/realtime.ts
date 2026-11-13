import { io, type Socket } from 'socket.io-client';
import type { Command, FleetDeltaMsg, Incident, PlatformMetrics, ResyncMsg, SubscribeAck, TelemetryBatchMsg } from '@coldguard/shared';

export type ConnStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'dropped';

interface Want {
  groups: string[];
  devices: string[];
}

type Handlers = {
  telemetry: (m: TelemetryBatchMsg) => void;
  fleet: (m: FleetDeltaMsg) => void;
  incident: (i: Incident) => void;
  command: (c: Command) => void;
  platform: (m: PlatformMetrics) => void;
  resync: (m: ResyncMsg) => void;
  /** Fired after a (re)connection's subscription is acknowledged. */
  subscribed: (ack: SubscribeAck, reconnect: boolean) => void;
  status: (s: ConnStatus) => void;
};

/** Bounded latency sample store for client-side delivery latency. */
class Samples {
  private a: number[] = [];
  add(v: number) {
    this.a.push(v);
    if (this.a.length > 2000) this.a.splice(0, this.a.length - 2000);
  }
  pct(p: number) {
    if (!this.a.length) return null;
    const s = [...this.a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  }
  get count() {
    return this.a.length;
  }
}

/**
 * One Socket.IO connection per browser tab.
 *
 * Views declare what they need with `want(key, {groups, devices})`. The
 * manager sends the union as a single `subscribe` and resolves each caller
 * with the acknowledgement (which carries the watermark). On reconnect it
 * re-subscribes automatically and emits `subscribed(ack, true)` so views can
 * catch up from MongoDB — Socket.IO itself is not treated as durable.
 */
class Realtime {
  private socket: Socket | null = null;
  private wants = new Map<string, Want>();
  private waiters: { want: Want; resolve: (a: SubscribeAck) => void }[] = [];
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers: { [K in keyof Handlers]: Set<Handlers[K]> } = {
    telemetry: new Set(),
    fleet: new Set(),
    incident: new Set(),
    command: new Set(),
    platform: new Set(),
    resync: new Set(),
    subscribed: new Set(),
    status: new Set(),
  };
  private hadConnection = false;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  status: ConnStatus = 'idle';
  /** serverClock − clientClock (ms), from the lowest-RTT probe. */
  clockOffset = 0;
  rtt: number | null = null;
  private probes: { rtt: number; offset: number }[] = [];
  /** Server receivedAt → this tab's receipt, corrected by the clock offset. */
  readonly deliveryMs = new Samples();
  lastAck: SubscribeAck | null = null;
  reconnects = 0;
  private requestHandlers = new Map<string, (payload: any, ack?: (r: unknown) => void) => void>();

  /** Register a handler for a server→client request (e.g. a command sent to a phone truck). */
  onRequest(event: string, fn: (payload: any, ack?: (r: unknown) => void) => void) {
    this.requestHandlers.set(event, fn);
    this.socket?.off(event).on(event, fn);
    return () => {
      this.requestHandlers.delete(event);
      this.socket?.off(event);
    };
  }

  /** Fire-and-forget client→server message. */
  send(event: string, payload: unknown) {
    this.socket?.emit(event, payload);
  }

  connect(token: string) {
    this.disconnect();
    this.setStatus('connecting');
    const s = io({ auth: { token }, transports: ['websocket'], reconnectionDelay: 500, reconnectionDelayMax: 4000 });
    this.socket = s;
    s.on('connect', () => {
      const reconnect = this.hadConnection;
      if (reconnect) this.reconnects++;
      this.hadConnection = true;
      this.setStatus('live');
      this.probeClock();
      this.sync(reconnect);
    });
    s.on('disconnect', () => this.setStatus(this.status === 'dropped' ? 'dropped' : 'reconnecting'));
    s.on('connect_error', (e) => {
      if (e.message === 'unauthenticated') {
        this.emit('status', 'idle');
      }
      if (this.status !== 'dropped') this.setStatus(this.hadConnection ? 'reconnecting' : 'connecting');
    });
    s.on('telemetry', (m: TelemetryBatchMsg) => {
      const now = Date.now() + this.clockOffset;
      for (let i = 0; i < m.events.length; i += 1) this.deliveryMs.add(now - m.events[i].r);
      this.emit('telemetry', m);
    });
    s.on('fleet', (m: FleetDeltaMsg) => this.emit('fleet', m));
    s.on('incident', (i: Incident) => this.emit('incident', i));
    s.on('command', (c: Command) => this.emit('command', c));
    s.on('platform', (m: PlatformMetrics) => this.emit('platform', m));
    s.on('resync', (m: ResyncMsg) => this.emit('resync', m));
    s.on('catalog', () => this.emit('resync', { reason: 'gap' }));
    for (const [ev, fn] of this.requestHandlers) s.on(ev, fn);
    this.clockTimer = setInterval(() => this.probeClock(), 15_000);
  }

  disconnect() {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.hadConnection = false;
    this.setStatus('idle');
  }

  /** Demo aid: really drop the connection for `ms`, then reconnect and catch up. */
  simulateDrop(ms: number) {
    if (!this.socket) return;
    this.setStatus('dropped');
    this.socket.disconnect();
    setTimeout(() => {
      this.setStatus('connecting');
      this.socket?.connect();
    }, ms);
  }

  on<K extends keyof Handlers>(k: K, fn: Handlers[K]): () => void {
    this.handlers[k].add(fn);
    return () => this.handlers[k].delete(fn);
  }

  private emit<K extends keyof Handlers>(k: K, ...args: Parameters<Handlers[K]>) {
    for (const fn of this.handlers[k]) (fn as (...a: unknown[]) => void)(...args);
  }

  private setStatus(s: ConnStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  /** Declare (or replace) what a view needs. Resolves once the server has joined the rooms. */
  want(key: string, w: Want): Promise<SubscribeAck> {
    this.wants.set(key, w);
    const p = new Promise<SubscribeAck>((resolve) => this.waiters.push({ want: w, resolve }));
    this.scheduleSync();
    return p;
  }

  release(key: string) {
    if (this.wants.delete(key)) this.scheduleSync();
  }

  private scheduleSync() {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.sync(false);
    }, 20);
  }

  private sync(reconnect: boolean) {
    const s = this.socket;
    if (!s?.connected) return; // will sync on connect
    const groups = new Set<string>();
    const devices = new Set<string>();
    for (const w of this.wants.values()) {
      w.groups.forEach((g) => groups.add(g));
      w.devices.forEach((d) => devices.add(d));
    }
    const waiting = this.waiters;
    this.waiters = [];
    s.timeout(8000).emit('subscribe', { groups: [...groups], devices: [...devices] }, (err: Error | null, ack: SubscribeAck) => {
      if (err || !ack?.ok) {
        console.warn('[rt] subscribe failed', err?.message ?? ack?.error);
        this.waiters.push(...waiting);
        setTimeout(() => this.scheduleSync(), 1000);
        return;
      }
      this.lastAck = ack;
      for (const w of waiting) w.resolve(ack);
      this.emit('subscribed', ack, reconnect);
    });
  }

  private probeClock() {
    const s = this.socket;
    if (!s?.connected) return;
    const t0 = Date.now();
    s.timeout(5000).emit('clock', (err: Error | null, serverTime: number) => {
      if (err) return;
      const t1 = Date.now();
      const rtt = t1 - t0;
      this.probes.push({ rtt, offset: serverTime - (t0 + t1) / 2 });
      if (this.probes.length > 8) this.probes.shift();
      const best = this.probes.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      this.clockOffset = best.offset;
      this.rtt = rtt;
    });
  }
}

export const realtime = new Realtime();
