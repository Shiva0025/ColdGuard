import { MongoClient, type Collection, type Db } from 'mongodb';
import type { DeviceInfo, GroupInfo, Incident, Rules } from '@coldguard/shared';
import type { CommandDoc } from './commands.js';
import type { EvidenceDoc } from './evidence.js';

/** Persisted telemetry document. Short field names keep the hot collection compact. */
export interface TelemetryDoc {
  _id: string; // eventId — unique ⇒ idempotent ingestion
  d: string; // deviceId
  s: string; // sessionId
  q: number; // seq
  t: Date; // observedAt (device clock)
  r: Date; // receivedAt (server clock) — TTL retention key
  c: number; // commit cursor (server, monotonic)
  tc: number;
  h: number;
  b: number;
  cs: number;
  p?: number;
  door?: 0 | 1;
  late?: true;
  a: string; // agentId that delivered it
}

export interface UserDoc {
  _id: string; // username
  passwordHash: string;
  role: 'operator' | 'viewer';
  displayName: string;
  groups: string[]; // authorised device groups
}

export interface AgentDoc {
  _id: string; // agentId
  secretSha256: string;
  groups: string[];
  description: string;
}

export interface DeviceDoc extends Omit<DeviceInfo, 'id'> {
  _id: string;
}

export interface GroupDoc extends Omit<GroupInfo, 'id'> {
  _id: string;
}

export interface IncidentDoc extends Omit<Incident, 'id'> {
  _id: string;
}

export interface DeviceStateDoc {
  _id: string;
  pos: { sessionId: string; seq: number; observedAt: number } | null;
  snapshot: Record<string, unknown>;
  updatedAt: Date;
}

export interface SettingsDoc {
  _id: string;
  rules?: Rules;
  cursorHighWater?: number;
  invite?: { code: string; expiresAt: number; maxClaims: number; createdBy: string };
  tamper?: { eventId: string; field: 'tc'; original: number; altered: number; at: number };
  updatedAt: Date;
  updatedBy?: string;
}

export interface Collections {
  telemetry: Collection<TelemetryDoc>;
  users: Collection<UserDoc>;
  agents: Collection<AgentDoc>;
  devices: Collection<DeviceDoc>;
  groups: Collection<GroupDoc>;
  incidents: Collection<IncidentDoc>;
  deviceState: Collection<DeviceStateDoc>;
  settings: Collection<SettingsDoc>;
  commands: Collection<CommandDoc>;
  guests: Collection<GuestDoc>;
  evidence: Collection<EvidenceDoc>;
}

/** A guest truck currently claimed by an audience member's phone. */
export interface GuestDoc {
  _id: string; // deviceId
  name: string;
  claimedAt: Date;
  expiresAt: Date;
}

export interface Database {
  client: MongoClient;
  db: Db;
  col: Collections;
  close(): Promise<void>;
}

export async function connectDb(url: string, opts: { retentionHours: number }): Promise<Database> {
  const client = new MongoClient(url, { maxPoolSize: 20, serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db();
  const col: Collections = {
    telemetry: db.collection('telemetry'),
    users: db.collection('users'),
    agents: db.collection('agents'),
    devices: db.collection('devices'),
    groups: db.collection('groups'),
    incidents: db.collection('incidents'),
    deviceState: db.collection('device_state'),
    settings: db.collection('settings'),
    commands: db.collection('commands'),
    guests: db.collection('guests'),
    evidence: db.collection('evidence'),
  };
  await ensureIndexes(col, opts.retentionHours);
  return { client, db, col, close: () => client.close() };
}

/**
 * Index design (see ARCHITECTURE.md):
 *  - telemetry._id (eventId) unique: authoritative dedupe at the DB boundary;
 *  - (d,s,q) unique: one reading per source position, even if a client re-mints an eventId;
 *  - (d,t): device time-range history + aggregation;
 *  - (d,c): reconnect catch-up "everything for device X after cursor C";
 *  - r TTL: retention.
 * An ordinary collection is used (not a time-series collection) because
 * time-series collections do not support unique indexes, which we need for
 * idempotent ingestion.
 */
async function ensureIndexes(col: Collections, retentionHours: number) {
  await Promise.all([
    col.telemetry.createIndex({ d: 1, s: 1, q: 1 }, { unique: true, name: 'source_position_unique' }),
    col.telemetry.createIndex({ d: 1, t: 1 }, { name: 'device_time' }),
    col.telemetry.createIndex({ d: 1, c: 1 }, { name: 'device_cursor' }),
    ensureTtl(col, retentionHours * 3600),
    col.incidents.createIndex(
      { deviceId: 1, type: 1 },
      { unique: true, partialFilterExpression: { active: true }, name: 'one_active_incident_per_device_type' },
    ),
    col.incidents.createIndex({ groupId: 1, active: 1, triggeredAt: -1 }, { name: 'group_active_recent' }),
    col.incidents.createIndex({ deviceId: 1, triggeredAt: -1 }, { name: 'device_recent' }),
    col.devices.createIndex({ groupId: 1 }, { name: 'group' }),
  ]);
}

async function ensureTtl(col: Collections, seconds: number) {
  try {
    await col.telemetry.createIndex({ r: 1 }, { expireAfterSeconds: seconds, name: 'retention_ttl' });
  } catch {
    // Retention changed: update the TTL in place.
    await col.telemetry.db.command({ collMod: 'telemetry', index: { name: 'retention_ttl', expireAfterSeconds: seconds } });
  }
}
