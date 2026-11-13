import type { Incident, IncidentType } from '@coldguard/shared';
import type { Collections, IncidentDoc } from './db.js';

const toDoc = ({ id, ...rest }: Incident): IncidentDoc => ({ _id: id, ...rest });
export const fromDoc = ({ _id, ...rest }: IncidentDoc): Incident => ({ id: _id, ...rest });

/**
 * Owns active incidents. Deduplication is enforced twice:
 *  - in memory: at most one active incident per (deviceId, type);
 *  - in MongoDB: partial unique index {deviceId,type} where active=true.
 * Writes are serialised through a promise chain so the DB sees transitions in
 * the same order the engine produced them; listeners are notified after the
 * write succeeds.
 */
export class IncidentManager {
  private active = new Map<string, Incident>();
  private chain: Promise<unknown> = Promise.resolve();
  private listeners: ((i: Incident) => void)[] = [];
  writeErrors = 0;

  constructor(private col: Collections) {}

  key(deviceId: string, type: IncidentType) {
    return `${deviceId}:${type}`;
  }

  async load() {
    this.active.clear();
    const docs = await this.col.incidents.find({ active: true }).toArray();
    for (const d of docs) {
      const i = fromDoc(d);
      this.active.set(this.key(i.deviceId, i.type), i);
    }
  }

  onChange(fn: (i: Incident) => void) {
    this.listeners.push(fn);
  }

  get(deviceId: string, type: IncidentType): Incident | undefined {
    return this.active.get(this.key(deviceId, type));
  }

  activeFor(deviceId: string): Incident[] {
    const out: Incident[] = [];
    for (const i of this.active.values()) if (i.deviceId === deviceId) out.push(i);
    return out;
  }

  allActive(): Incident[] {
    return [...this.active.values()];
  }

  /** Opens an incident unless one of the same type is already active (dedupe). */
  open(i: Incident): Incident {
    const k = this.key(i.deviceId, i.type);
    const existing = this.active.get(k);
    if (existing) return existing;
    this.active.set(k, i);
    this.enqueue(async () => {
      try {
        await this.col.incidents.insertOne(toDoc(i));
      } catch (e: any) {
        if (e?.code === 11000) {
          // An active incident already exists in the DB (e.g. raced with a restart). Adopt it.
          const doc = await this.col.incidents.findOne({ deviceId: i.deviceId, type: i.type, active: true });
          if (doc) this.active.set(k, fromDoc(doc));
          return;
        }
        throw e;
      }
      this.emit(i);
    });
    return i;
  }

  /** Persist a changed incident (timeline/evidence/state). */
  save(i: Incident) {
    const snapshot = structuredClone(i);
    if (!i.active) this.active.delete(this.key(i.deviceId, i.type));
    this.enqueue(async () => {
      const { _id, ...rest } = toDoc(snapshot);
      await this.col.incidents.updateOne({ _id }, { $set: rest });
      this.emit(snapshot);
    });
  }

  resolve(i: Incident, at: number, text: string) {
    i.active = false;
    i.state = 'resolved';
    i.resolvedAt = at;
    i.recoveringSince = null;
    i.timeline.push({ at, kind: 'resolved', text });
    this.save(i);
  }

  /** Append an operator-action entry to an incident's timeline (active or not). */
  async note(id: string, text: string, by?: string) {
    let inc = [...this.active.values()].find((x) => x.id === id);
    if (!inc) {
      const doc = await this.col.incidents.findOne({ _id: id });
      if (!doc) return;
      inc = fromDoc(doc);
    }
    inc.timeline.push({ at: Date.now(), kind: 'action', text, ...(by ? { by } : {}) });
    this.save(inc);
  }

  async acknowledge(id: string, by: string, note: string | undefined): Promise<Incident | 'not_found' | 'already'> {
    let inc = [...this.active.values()].find((x) => x.id === id);
    if (!inc) {
      const doc = await this.col.incidents.findOne({ _id: id });
      if (!doc) return 'not_found';
      inc = fromDoc(doc);
    }
    if (inc.ack) return 'already';
    const at = Date.now();
    inc.ack = { by, at, ...(note ? { note } : {}) };
    if (inc.state === 'open') inc.state = 'acknowledged';
    inc.timeline.push({ at, kind: 'acknowledged', text: note ? `Acknowledged: ${note}` : 'Acknowledged', by });
    this.save(inc);
    await this.flush();
    return inc;
  }

  /** Wait until all queued writes are durable. */
  flush() {
    return this.chain;
  }

  reset() {
    this.active.clear();
  }

  private enqueue(fn: () => Promise<void>) {
    this.chain = this.chain.then(fn).catch((e) => {
      this.writeErrors++;
      console.error('[incidents] write failed:', e?.message ?? e);
    });
  }

  private emit(i: Incident) {
    for (const l of this.listeners) l(i);
  }
}
