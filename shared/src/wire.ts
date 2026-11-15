import type { CoolingState, Rules } from './schemas.js';

export type Role = 'operator' | 'viewer' | 'driver';
export type DeviceStatus = 'healthy' | 'warning' | 'critical' | 'offline';

/**
 * Compact persisted reading as delivered to clients (REST history and Socket.IO).
 * `c` is the server commit cursor: strictly increasing in persistence order,
 * assigned by the single writer, and used as the history/live watermark.
 */
export interface Reading {
  id: string; // eventId
  d: string; // deviceId
  s: string; // sessionId
  q: number; // per-source sequence number
  t: number; // observedAt (device clock, ms)
  r: number; // receivedAt (server clock, ms)
  c: number; // commit cursor
  tc: number; // temperature °C
  h: number; // humidity %RH
  b: number; // battery %
  cs: number; // cooling state code: 0 off, 1 on, 2 fault
  p?: number; // route progress 0..1 (simulated)
  door?: 0 | 1; // compartment door open
  late?: 1; // arrived after a newer reading from the same device (did not change current state)
}

/** Time-bucketed aggregate used for long ranges. */
export interface Bucket {
  t: number; // bucket start (ms)
  n: number; // reading count
  tMin: number;
  tMax: number;
  tAvg: number;
  h: number; // avg humidity
  b: number; // min battery
  fault: number; // count of readings with cooling fault
}

export interface DeviceInfo {
  id: string;
  name: string;
  kind: 'shipment' | 'facility';
  groupId: string;
  origin: string;
  destination: string;
  product: string;
  /** Simulated inventory exposure. Clearly labelled as simulated in the UI. */
  simulatedDoses: number;
  simulatedValueInr: number;
}

export interface DeviceState {
  id: string;
  v: number; // per-device state version (monotonic) — clients ignore older versions
  status: DeviceStatus;
  reasons: string[];
  t: number | null; // observedAt of the newest in-order reading
  r: number | null; // receivedAt of the newest in-order reading
  tc: number | null;
  h: number | null;
  b: number | null;
  cs: number | null;
  progress: number; // 0..1 along route (simulated, derived from device clock)
  door: 0 | 1 | null;
  /** Cumulative °C·min outside the configured band (in-order readings, live). */
  exposure: number;
  openIncidents: number;
  /**
   * Time-to-breach forecast: linear extrapolation of the current least-squares
   * slope to the nearest limit. Present only while in range and trending out.
   */
  eta?: { sec: number; limit: 'high' | 'low'; limitC: number; slopeCPerMin: number } | null;
}

export interface GroupInfo {
  id: string;
  name: string;
  region: string;
}

export type IncidentType = 'temp_high' | 'temp_low' | 'rapid_drift' | 'sensor_offline' | 'low_battery' | 'exposure_budget';
export type IncidentState = 'open' | 'acknowledged' | 'resolved';

export interface IncidentEvidenceReading {
  eventId: string;
  t: number;
  tc: number;
}

export interface Incident {
  id: string;
  deviceId: string;
  groupId: string;
  type: IncidentType;
  severity: 'warning' | 'critical';
  state: IncidentState;
  /** True while not resolved (unique per device+type ⇒ dedupe). */
  active: boolean;
  openedAt: number; // observedAt of first qualifying reading
  triggeredAt: number; // observedAt when the rule was satisfied
  explanation: string;
  rule: Partial<Rules>;
  evidence: {
    first?: IncidentEvidenceReading;
    trigger?: IncidentEvidenceReading;
    peak?: IncidentEvidenceReading;
    readings: number;
    lastSeenAt?: number;
    slopeCPerMin?: number;
  };
  ack?: { by: string; at: number; note?: string };
  recoveringSince?: number | null;
  resolvedAt?: number;
  timeline: { at: number; kind: string; text: string; by?: string }[];
}

export interface PlatformMetrics {
  at: number;
  ingest: {
    acceptedPerSec: number;
    persistedPerSec: number;
    rejectedPerSec: number;
    duplicatePerSec: number;
    totals: { offered: number; accepted: number; persisted: number; duplicates: number; rejected: number; overload: number; rateLimited: number; late: number };
  };
  queue: { depth: number; capacity: number; overloaded: boolean };
  db: { batchP50: number | null; batchP95: number | null; batchP99: number | null; lastBatchSize: number };
  /** receivedAt → Socket.IO emit, measured on the server clock (ms). */
  pipeline: { p50: number | null; p95: number | null; p99: number | null };
  sockets: { connected: number; lagging: number; emittedPerSec: number };
  process: { rssMb: number; heapMb: number; cpuPct: number; eventLoopP99Ms: number; uptimeSec: number };
  simulator: SimulatorStatus | null;
}

export interface SimulatorStatus {
  connected: boolean;
  running: boolean;
  deviceCount: number;
  intervalMs: number;
  seed: number;
  sentPerSec: number;
  backoffMs: number;
  retries: number;
  activeFaults: { kind: string; deviceId?: string; until?: number }[];
  lastSeenAt: number;
  /** Per-device delivery state for devices with anything buffered, queued or faulty. */
  devices?: Record<string, SimDeviceNet>;
}

export interface SimDeviceNet {
  offline: boolean; // device cannot upload (store-and-forward buffering)
  buffered: number; // readings held on the device
  outbox: number; // readings handed to the uplink, awaiting a durable ack
  heldOutOfOrder: number;
  backfillTotal: number; // size of the last reconnect burst
  backfillDelivered: number;
  pendingCommands: number;
  faults: string[];
}

// ---- Socket.IO message shapes -------------------------------------------

export interface TelemetryBatchMsg {
  /** server emit time (server clock) */
  st: number;
  events: Reading[];
}

export interface FleetDeltaMsg {
  st: number;
  states: DeviceState[];
}

export interface SubscribeAck {
  ok: boolean;
  error?: string;
  groups: string[];
  devices: string[];
  /** Highest commit cursor durable at the moment the subscription became active. */
  watermark: number;
  serverTime: number;
}

export interface ResyncMsg {
  reason: 'slow-consumer' | 'server-restart' | 'gap';
}

export const ROOM = {
  group: (g: string) => `group:${g}`,
  device: (d: string) => `device:${d}`,
  groupAlerts: (g: string) => `alerts:${g}`,
  platform: 'platform',
  lagging: 'lagging',
} as const;

// ---- Operator commands (interactive rescue) -------------------------------

export type CommandState = 'requested' | 'delivered' | 'acknowledged' | 'effect_observed' | 'failed';

export interface Command {
  id: string;
  deviceId: string;
  groupId: string;
  kind: 'close_door' | 'restore_cooling' | 'backup_cooling';
  incidentId?: string;
  state: CommandState;
  requestedBy: string;
  requestedAt: number;
  /** Simulator received it (may be queued on the device while it is offline). */
  deliveredAt?: number;
  queuedOffline?: boolean;
  /** The device applied it (device clock). */
  acknowledgedAt?: number;
  /** First reading proving the effect. */
  effectAt?: number;
  effect?: { eventId: string; t: number; tc: number; text: string };
  /** Temperature at acknowledgement, for effect detection. */
  baseline?: { t: number; tc: number };
  failure?: string;
  /**
   * SIMULATED counterfactual: the same thermal model, cloned at the moment the
   * device applied the command, continued WITHOUT the command.
   */
  counterfactual?: { points: [number, number][]; horizonSec: number; label: string };
  timeline: { at: number; state: CommandState | 'note'; text: string }[];
}

export interface SimCommandMsg {
  id: string;
  deviceId: string;
  kind: Command['kind'];
}

export interface SimCommandAck {
  id: string;
  deviceId: string;
  phase: 'delivered' | 'applied' | 'failed';
  queuedOffline?: boolean;
  appliedAt?: number;
  reason?: string;
  counterfactual?: [number, number][];
  horizonSec?: number;
}
