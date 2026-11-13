import { COOLING_CODE, type Reading, type TelemetryEventIn } from '@coldguard/shared';
import type { AnyBulkWriteOperation } from 'mongodb';
import type { Collections, TelemetryDoc } from './db.js';
import type { StateEngine } from './engine.js';
import { RateCounter, Reservoir } from './metrics.js';

export interface IngestResult {
  persisted: number;
  duplicates: number;
  late: number;
  failed: number;
}

interface Ticket {
  remaining: number;
  result: IngestResult;
  resolve: (r: IngestResult) => void;
}

interface Item {
  ev: TelemetryEventIn;
  agentId: string;
  receivedAt: number;
  ticket: Ticket;
}

export class OverloadError extends Error {
  constructor(public retryAfterSec: number) {
    super('ingest queue full');
  }
}

/**
 * Bounded ingestion queue with a single ordered writer.
 *
 *   HTTP handler ──enqueue()──▶ [bounded queue] ──▶ writer: insertMany (≤ DB_BATCH_MAX, unordered)
 *                                                         │ duplicates rejected by unique _id / (d,s,q)
 *                                                         ▼
 *                                   commit cursor advanced ─▶ state engine ─▶ broadcaster
 *
 * - Admission is all-or-nothing per request: if the batch does not fit, the
 *   request gets 503 + Retry-After and nothing is enqueued (no silent drops).
 * - The HTTP response is sent only after every event of the request has been
 *   written (or found to be a duplicate) — i.e. durable acknowledgement.
 * - Cursors are assigned by the single writer in batch order, so "cursor ≤
 *   committed" means "durably visible to queries" (the history watermark).
 */
export class IngestPipeline {
  private queue: Item[] = [];
  private head = 0;
  private running = false;
  private stopped = false;
  private wake: (() => void) | null = null;
  private lastCursor: number;
  /** Highest cursor whose batch insert has completed. */
  committed: number;

  readonly stats = {
    offered: new RateCounter(),
    accepted: new RateCounter(),
    persisted: new RateCounter(),
    duplicates: new RateCounter(),
    rejected: new RateCounter(),
    overload: new RateCounter(),
    rateLimited: new RateCounter(),
    late: new RateCounter(),
    batchMs: new Reservoir(1024),
    lastBatchSize: 0,
    writeFailures: 0,
  };

  /** Per-device counters since server start (break-the-network panel). */
  readonly perDevice = new Map<string, { duplicates: number; backfilled: number; late: number }>();
  private dev(id: string) {
    let d = this.perDevice.get(id);
    if (!d) this.perDevice.set(id, (d = { duplicates: 0, backfilled: 0, late: 0 }));
    return d;
  }

  onPersisted: (readings: Reading[]) => void = () => {};

  constructor(
    private col: Collections,
    private engine: StateEngine,
    private opts: { capacity: number; batchMax: number; lingerMs: number },
    startCursor: number,
  ) {
    // Hybrid cursor: never below wall-clock µs-ish, never below anything persisted before.
    this.lastCursor = Math.max(startCursor, Date.now() * 1000);
    this.committed = this.lastCursor;
  }

  get depth() {
    return this.queue.length - this.head;
  }
  get capacity() {
    return this.opts.capacity;
  }

  /** Admit a validated batch. Resolves after durable persistence. */
  enqueue(events: TelemetryEventIn[], agentId: string, receivedAt = Date.now()): Promise<IngestResult> {
    if (this.stopped) return Promise.reject(new OverloadError(2));
    if (this.depth + events.length > this.opts.capacity) {
      this.stats.overload.add(events.length);
      throw new OverloadError(Math.max(1, Math.ceil(this.depth / Math.max(1000, this.stats.persisted.rate() || 1000))));
    }
    this.stats.accepted.add(events.length);
    return new Promise<IngestResult>((resolve) => {
      const ticket: Ticket = { remaining: events.length, result: { persisted: 0, duplicates: 0, late: 0, failed: 0 }, resolve };
      for (const ev of events) this.queue.push({ ev, agentId, receivedAt, ticket });
      this.kick();
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  async stop() {
    this.stopped = true;
    this.kick();
    while (this.running) await new Promise((r) => setTimeout(r, 10));
  }

  private kick() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private async loop() {
    while (true) {
      if (this.depth === 0) {
        if (this.stopped) break;
        await new Promise<void>((r) => (this.wake = r));
        continue;
      }
      // Linger briefly so small requests coalesce into larger DB batches.
      if (this.depth < this.opts.batchMax && this.opts.lingerMs > 0 && !this.stopped) {
        await new Promise((r) => setTimeout(r, this.opts.lingerMs));
      }
      const n = Math.min(this.depth, this.opts.batchMax);
      const items = this.queue.slice(this.head, this.head + n);
      this.head += n;
      if (this.head > 50_000 || this.head === this.queue.length) {
        this.queue = this.queue.slice(this.head);
        this.head = 0;
      }
      await this.writeBatch(items);
    }
    this.running = false;
  }

  private async writeBatch(items: Item[]) {
    const provisional = new Map();
    const docs: TelemetryDoc[] = items.map((it) => {
      const e = it.ev;
      const late = this.engine.classify(e.deviceId, { sessionId: e.sessionId, seq: e.seq, observedAt: e.observedAt }, provisional) === 'late';
      const doc: TelemetryDoc = {
        _id: e.eventId,
        d: e.deviceId,
        s: e.sessionId,
        q: e.seq,
        t: new Date(e.observedAt),
        r: new Date(it.receivedAt),
        c: ++this.lastCursor,
        tc: e.metrics.tempC,
        h: e.metrics.humidityPct,
        b: e.metrics.batteryPct,
        cs: COOLING_CODE[e.metrics.cooling],
        a: it.agentId,
      };
      if (e.metrics.routeProgress !== undefined) doc.p = e.metrics.routeProgress;
      if (e.metrics.doorOpen !== undefined) doc.door = e.metrics.doorOpen ? 1 : 0;
      if (late) doc.late = true;
      return doc;
    });

    const dupIdx = new Set<number>();
    let failedAll = false;
    const t0 = performance.now();
    try {
      await this.col.telemetry.insertMany(docs, { ordered: false });
    } catch (e: any) {
      const errs: any[] = e?.writeErrors ? (Array.isArray(e.writeErrors) ? e.writeErrors : Object.values(e.writeErrors)) : [];
      if (errs.length === 0) {
        failedAll = true;
        this.stats.writeFailures++;
        console.error('[pipeline] batch insert failed:', e?.message ?? e);
      }
      for (const we of errs) {
        const code = we.code ?? we.err?.code;
        const idx = we.index ?? we.err?.index;
        if (code === 11000) dupIdx.add(idx);
        else {
          // Non-duplicate per-document error: count as failed (retryable for the client).
          dupIdx.add(-1 - idx);
        }
      }
    }
    const ms = performance.now() - t0;
    this.stats.batchMs.add(ms);
    this.stats.lastBatchSize = docs.length;

    const persisted: Reading[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const d = docs[i];
      const res = it.ticket.result;
      if (failedAll || dupIdx.has(-1 - i)) res.failed++;
      else if (dupIdx.has(i)) {
        res.duplicates++;
        this.stats.duplicates.add();
        this.dev(d.d).duplicates++;
      } else {
        res.persisted++;
        if (d.late) {
          res.late++;
          this.dev(d.d).late++;
        }
        // Delivered ≥ 10 s after it was observed: store-and-forward backfill.
        if (+d.r - +d.t >= 10_000) this.dev(d.d).backfilled++;
        persisted.push(toReading(d));
      }
      if (--it.ticket.remaining === 0) it.ticket.resolve(it.ticket.result);
    }
    this.stats.persisted.add(persisted.length);
    this.stats.late.add(persisted.filter((p) => p.late).length);
    // Everything up to the last cursor in this batch is now durable (single writer).
    this.committed = docs[docs.length - 1].c;
    if (persisted.length) this.onPersisted(persisted);
  }
}

export function toReading(d: TelemetryDoc): Reading {
  const r: Reading = { id: d._id, d: d.d, s: d.s, q: d.q, t: +d.t, r: +d.r, c: d.c, tc: d.tc, h: d.h, b: d.b, cs: d.cs };
  if (d.p !== undefined) r.p = d.p;
  if (d.door !== undefined) r.door = d.door;
  if (d.late) r.late = 1;
  return r;
}

export type { AnyBulkWriteOperation };
