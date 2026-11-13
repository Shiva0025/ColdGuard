import { useSyncExternalStore } from 'react';
import type { DeviceInfo, DeviceState, FleetDeltaMsg, GroupInfo, Incident, PlatformMetrics, Rules } from '@coldguard/shared';
import { api } from './api';
import { realtime, type ConnStatus } from './realtime';

/**
 * Base for stores that mutate in place on every socket message but notify
 * React at a bounded cadence. Socket traffic never triggers a render
 * directly — at most one render per `intervalMs` per store.
 */
export class ThrottledStore {
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  version = 0;
  renders = 0;
  constructor(private intervalMs: number) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  protected changed() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.version++;
      this.renders++;
      for (const l of this.listeners) l();
    }, this.intervalMs);
  }
  protected changedNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.version++;
    for (const l of this.listeners) l();
  }
}

export function useStore(s: ThrottledStore) {
  return useSyncExternalStore(s.subscribe, s.getVersion);
}

// ---------------------------------------------------------------------------

const SPARK_MAX = 90;

class FleetStore extends ThrottledStore {
  groups: GroupInfo[] = [];
  selectedGroups: string[] = [];
  devices = new Map<string, DeviceInfo>();
  states = new Map<string, DeviceState>();
  sparks = new Map<string, number[]>();
  private sparkAt = new Map<string, number>();
  rules: Rules | null = null;
  loading = true;
  error: string | null = null;
  deltasApplied = 0;
  staleDeltasIgnored = 0;
  outOfScopeIgnored = 0;
  private gen = 0;
  private abort: AbortController | null = null;
  private pending: DeviceState[] = [];
  private loaded = false;

  constructor() {
    super(250);
    realtime.on('fleet', (m) => this.onDelta(m));
    realtime.on('subscribed', (_ack, reconnect) => {
      if (reconnect && this.selectedGroups.length) void this.load(this.selectedGroups);
    });
    realtime.on('resync', () => this.selectedGroups.length && void this.load(this.selectedGroups));
  }

  /**
   * Switch the overview to `groups`. Join the rooms first, then fetch the
   * snapshot; deltas received meanwhile are held and applied by version.
   */
  async load(groups: string[]) {
    const gen = ++this.gen;
    this.abort?.abort();
    const ac = (this.abort = new AbortController());
    this.selectedGroups = groups;
    this.loaded = false;
    this.pending = [];
    this.loading = true;
    this.error = null;
    this.changedNow();
    try {
      await realtime.want('fleet', { groups, devices: [] });
      if (gen !== this.gen) return;
      const snap = await api<{
        groups: GroupInfo[];
        devices: DeviceInfo[];
        states: DeviceState[];
        sparks: Record<string, number[]>;
        rules: Rules;
      }>(`/fleet?groups=${encodeURIComponent(groups.join(','))}`, { signal: ac.signal });
      if (gen !== this.gen) return; // a newer filter won — drop this response
      this.groups = snap.groups;
      this.rules = snap.rules;
      this.devices = new Map(snap.devices.map((d) => [d.id, d]));
      this.states = new Map(snap.states.map((s) => [s.id, s]));
      this.sparks = new Map(Object.entries(snap.sparks).map(([k, v]) => [k, [...v]]));
      this.sparkAt.clear();
      this.loaded = true;
      for (const s of this.pending) this.apply(s);
      this.pending = [];
      this.loading = false;
      this.changedNow();
    } catch (e: any) {
      if (e?.name === 'AbortError' || gen !== this.gen) return;
      this.error = e?.message ?? 'failed to load fleet';
      this.loading = false;
      this.changedNow();
    }
  }

  private onDelta(m: FleetDeltaMsg) {
    for (const s of m.states) {
      if (!this.loaded) {
        if (this.pending.length < 20_000) this.pending.push(s);
        continue;
      }
      this.apply(s);
    }
    this.changed();
  }

  private apply(s: DeviceState) {
    if (!this.devices.has(s.id)) {
      this.outOfScopeIgnored++; // delta for a group we no longer show
      return;
    }
    const cur = this.states.get(s.id);
    if (cur && cur.v >= s.v) {
      this.staleDeltasIgnored++;
      return;
    }
    this.states.set(s.id, s);
    this.deltasApplied++;
    if (s.tc != null && s.t != null) {
      const last = this.sparkAt.get(s.id) ?? 0;
      if (s.t - last >= 2000) {
        const arr = this.sparks.get(s.id) ?? [];
        arr.push(Math.round(s.tc * 10) / 10);
        if (arr.length > SPARK_MAX) arr.splice(0, arr.length - SPARK_MAX);
        this.sparks.set(s.id, arr);
        this.sparkAt.set(s.id, s.t);
      }
    }
  }

  setRules(r: Rules) {
    this.rules = r;
    this.changedNow();
  }
}

export const fleet = new FleetStore();

// ---------------------------------------------------------------------------

export interface Toast {
  id: string;
  incident: Incident;
  at: number;
}

class IncidentStore extends ThrottledStore {
  byId = new Map<string, Incident>();
  toasts: Toast[] = [];
  loading = true;
  constructor() {
    super(200);
    realtime.on('incident', (i) => this.onIncident(i));
    realtime.on('subscribed', (_a, reconnect) => reconnect && void this.load());
    realtime.on('resync', (m) => m.reason === 'server-restart' && void this.load());
  }
  async load() {
    try {
      const { incidents } = await api<{ incidents: Incident[] }>('/incidents?scope=all&limit=200');
      this.byId = new Map(incidents.map((i) => [i.id, i]));
    } finally {
      this.loading = false;
      this.changedNow();
    }
  }
  private onIncident(i: Incident) {
    const prev = this.byId.get(i.id);
    this.byId.set(i.id, i);
    if (!prev && i.active) {
      this.toasts = [{ id: i.id, incident: i, at: Date.now() }, ...this.toasts].slice(0, 4);
    }
    this.changed();
  }
  dismiss(id: string) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.changedNow();
  }
  upsert(i: Incident) {
    this.byId.set(i.id, i);
    this.changedNow();
  }
  active(): Incident[] {
    return [...this.byId.values()].filter((i) => i.active).sort(sortIncidents);
  }
  forDevice(id: string): Incident[] {
    return [...this.byId.values()].filter((i) => i.deviceId === id).sort((a, b) => b.triggeredAt - a.triggeredAt);
  }
  all(): Incident[] {
    return [...this.byId.values()].sort((a, b) => b.triggeredAt - a.triggeredAt);
  }
}

const SEV = { critical: 0, warning: 1 };
function sortIncidents(a: Incident, b: Incident) {
  if (!!a.ack !== !!b.ack) return a.ack ? 1 : -1;
  if (a.severity !== b.severity) return SEV[a.severity] - SEV[b.severity];
  return b.triggeredAt - a.triggeredAt;
}

export const incidents = new IncidentStore();

// ---------------------------------------------------------------------------

class PlatformStore extends ThrottledStore {
  latest: PlatformMetrics | null = null;
  history: { at: number; persisted: number; pipelineP95: number }[] = [];
  conn: ConnStatus = realtime.status;
  constructor() {
    super(100);
    realtime.on('platform', (m) => {
      this.latest = m;
      this.history.push({ at: m.at, persisted: m.ingest.persistedPerSec, pipelineP95: m.pipeline.p95 ?? 0 });
      if (this.history.length > 120) this.history.shift();
      this.changed();
    });
    realtime.on('status', (s) => {
      this.conn = s;
      this.changedNow();
    });
  }
}

export const platform = new PlatformStore();
