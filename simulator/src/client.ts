import type { TelemetryEventIn } from '@coldguard/shared';

export interface SendStats {
  sent: number; // events acknowledged as persisted
  duplicates: number;
  late: number;
  rejected: number; // non-retryable validation rejections
  retries: number;
  overload503: number;
  rateLimited429: number;
  networkErrors: number;
  droppedLocal: number; // logger buffer overflow (bounded outbox)
  ackLatencyMs: number[]; // request → durable ack, sampled
}

/**
 * Ingest client with a bounded outbox, bounded concurrency and exponential
 * backoff with full jitter. Retries reuse the same eventIds, so they are
 * idempotent at the server (unique index on eventId).
 */
export class IngestClient {
  private outbox: TelemetryEventIn[] = [];
  private inFlight = 0;
  backoffMs = 0;
  private attempt = 0;
  private pausedUntil = 0;
  /** Called with each batch once it is durably acknowledged (or definitively rejected). */
  onSettled: (batch: TelemetryEventIn[]) => void = () => {};
  stats: SendStats = { sent: 0, duplicates: 0, late: 0, rejected: 0, retries: 0, overload503: 0, rateLimited429: 0, networkErrors: 0, droppedLocal: 0, ackLatencyMs: [] };

  constructor(
    private url: string,
    private agentKey: string,
    private opts = { batchSize: 250, concurrency: 4, outboxMax: 50_000, baseBackoffMs: 250, maxBackoffMs: 8000 },
  ) {}

  get pending() {
    return this.outbox.length + this.inFlight;
  }

  push(events: TelemetryEventIn[]) {
    this.outbox.push(...events);
    const over = this.outbox.length - this.opts.outboxMax;
    if (over > 0) {
      this.onSettled(this.outbox.slice(0, over));
      this.outbox.splice(0, over);
      this.stats.droppedLocal += over;
    }
    this.pump();
  }

  pump() {
    while (this.inFlight < this.opts.concurrency && this.outbox.length > 0 && Date.now() >= this.pausedUntil) {
      const batch = this.outbox.splice(0, this.opts.batchSize);
      this.inFlight++;
      void this.send(batch).finally(() => {
        this.inFlight--;
        this.pump();
      });
    }
    if (this.outbox.length > 0 && Date.now() < this.pausedUntil) {
      setTimeout(() => this.pump(), this.pausedUntil - Date.now() + 1);
    }
  }

  private async send(batch: TelemetryEventIn[]): Promise<void> {
    const t0 = performance.now();
    let status = 0;
    let body: any = null;
    let retryAfter = 0;
    try {
      const res = await fetch(`${this.url}/api/ingest/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Agent ${this.agentKey}` },
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(15_000),
      });
      status = res.status;
      retryAfter = Number(res.headers.get('retry-after') ?? 0);
      body = await res.json().catch(() => null);
    } catch {
      this.stats.networkErrors++;
    }

    if (status === 200) {
      this.attempt = 0;
      this.backoffMs = 0;
      this.stats.sent += body?.persisted ?? 0;
      this.stats.duplicates += body?.duplicates ?? 0;
      this.stats.late += body?.late ?? 0;
      this.stats.rejected += body?.rejected?.length ?? 0;
      if (this.stats.ackLatencyMs.length < 20_000) this.stats.ackLatencyMs.push(performance.now() - t0);
      this.onSettled(batch);
      return;
    }
    if (status === 400 || status === 413 || status === 401 || status === 403) {
      // Non-retryable: count and drop (do not loop forever on bad data/credentials).
      this.stats.rejected += batch.length;
      if (status === 401) console.error('[sim] ingest credential rejected — check AGENT_KEY and seed');
      this.onSettled(batch);
      return;
    }
    // Retryable: 429, 503, 5xx, network. Back off with full jitter; respect Retry-After.
    if (status === 503) this.stats.overload503++;
    if (status === 429) this.stats.rateLimited429++;
    this.stats.retries++;
    this.attempt = Math.min(this.attempt + 1, 10);
    const exp = Math.min(this.opts.maxBackoffMs, this.opts.baseBackoffMs * 2 ** this.attempt);
    const delay = Math.max(retryAfter * 1000, exp * (0.5 + Math.random() * 0.5)) + Math.random() * 100;
    this.backoffMs = Math.round(delay);
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + delay);
    this.outbox.unshift(...batch); // same eventIds ⇒ idempotent retry
  }
}
