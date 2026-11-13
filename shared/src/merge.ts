import type { Reading } from './wire.js';

/**
 * Stable, deterministic display order for readings: observedAt, then deviceId,
 * sessionId, seq and finally eventId. Two clients that hold the same set of
 * readings always render the same sequence regardless of arrival order.
 */
export function compareReadings(a: Reading, b: Reading): number {
  if (a.t !== b.t) return a.t - b.t;
  if (a.d !== b.d) return a.d < b.d ? -1 : 1;
  if (a.s !== b.s) return a.s < b.s ? -1 : 1;
  if (a.q !== b.q) return a.q - b.q;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Position of the per-source stream used for "is this newer than current state?" */
export interface SourcePosition {
  sessionId: string;
  seq: number;
  observedAt: number;
}

/**
 * Current-state ordering policy (server side):
 *  - same session: higher seq is newer (seq is authoritative within a session);
 *  - different session: the reading is newer only if its observedAt is strictly
 *    later than the current state's observedAt (a device restart starts a new
 *    session whose seq restarts at 0).
 * Anything not newer is "late": it is persisted and shown in history but never
 * moves the device's current state backwards.
 */
export function isNewerThan(cur: SourcePosition | null | undefined, next: SourcePosition): boolean {
  if (!cur) return true;
  if (cur.sessionId === next.sessionId) return next.seq > cur.seq;
  return next.observedAt > cur.observedAt;
}

export interface WindowOptions {
  /** Hard bound on retained readings (oldest evicted first). */
  maxPoints: number;
}

/**
 * Bounded, deduplicated, ordered reading buffer for one view.
 * Used for the history+live merge on the client.
 *
 * Invariants:
 *  - no two readings share an eventId (dedupe on insert);
 *  - `items` is always sorted by compareReadings;
 *  - size never exceeds maxPoints (oldest evicted; eviction count reported).
 */
export class ReadingWindow {
  private ids = new Set<string>();
  items: Reading[] = [];
  maxCursor = 0;
  evicted = 0;
  duplicatesDropped = 0;
  version = 0;

  constructor(private opts: WindowOptions) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  get size(): number {
    return this.items.length;
  }

  /** Insert readings in any order. Returns number actually added. */
  insert(batch: readonly Reading[]): number {
    let added = 0;
    for (const r of batch) {
      if (this.ids.has(r.id)) {
        this.duplicatesDropped++;
        continue;
      }
      this.ids.add(r.id);
      if (r.c > this.maxCursor) this.maxCursor = r.c;
      const items = this.items;
      // Fast path: appending in order (the common live case).
      if (items.length === 0 || compareReadings(items[items.length - 1], r) <= 0) {
        items.push(r);
      } else {
        let lo = 0;
        let hi = items.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (compareReadings(items[mid], r) <= 0) lo = mid + 1;
          else hi = mid;
        }
        items.splice(lo, 0, r);
      }
      added++;
    }
    const over = this.items.length - this.opts.maxPoints;
    if (over > 0) {
      const removed = this.items.splice(0, over);
      for (const r of removed) this.ids.delete(r.id);
      this.evicted += over;
    }
    if (added > 0) this.version++;
    return added;
  }

  /** Drop readings older than `t` (time-window trimming). */
  trimBefore(t: number): void {
    let i = 0;
    while (i < this.items.length && this.items[i].t < t) i++;
    if (i > 0) {
      for (const r of this.items.slice(0, i)) this.ids.delete(r.id);
      this.items.splice(0, i);
      this.version++;
    }
  }

  clear(): void {
    this.ids.clear();
    this.items = [];
    this.maxCursor = 0;
    this.version++;
  }
}

/**
 * Race-safe history/live handoff, expressed as a pure function so it can be
 * tested exhaustively:
 *   1. caller joins the live room FIRST and buffers everything it receives;
 *   2. caller then loads history, which reports `watermark` = highest commit
 *      cursor that was durable before the query began;
 *   3. merge = history ∪ buffered live, deduplicated by eventId.
 * Every event with c ≤ watermark is visible to the history query; every event
 * with c > watermark is broadcast after the join and therefore buffered. The
 * union covers everything; the eventId dedupe removes the overlap.
 */
export function mergeHistoryAndLive(history: readonly Reading[], buffered: readonly Reading[], maxPoints: number): ReadingWindow {
  const w = new ReadingWindow({ maxPoints });
  w.insert(history);
  w.insert(buffered);
  return w;
}

/**
 * Canonical text of a stored reading for the evidence chain. Every field that
 * matters for an investigation is included, in a fixed order, so any change to
 * a stored value changes its hash.
 */
export function canonicalReading(r: Reading): string {
  return [r.id, r.d, r.s, r.q, r.t, r.r, r.c, r.tc, r.h, r.b, r.cs, r.door ?? '', r.late ? 1 : 0].join('|');
}

/** One sealed block of a device's evidence chain. */
export interface EvidenceBlock {
  d: string;
  n: number; // block number per device, from 0
  fromC: number; // commit-cursor range covered (inclusive)
  toC: number;
  count: number;
  leaves: string[]; // first 16 hex chars of sha256(canonical reading), in cursor order
  readingsHash: string; // sha256 of all canonical lines joined by "\n"
  prevHash: string;
  hash: string; // sha256(d|n|fromC|toC|count|readingsHash|prevHash)
  sealedAt: number;
}

export const blockHeader = (b: Pick<EvidenceBlock, 'd' | 'n' | 'fromC' | 'toC' | 'count' | 'readingsHash' | 'prevHash'>) =>
  [b.d, b.n, b.fromC, b.toC, b.count, b.readingsHash, b.prevHash].join('|');
export const genesisSeed = (d: string) => `coldguard-genesis:${d}`;
