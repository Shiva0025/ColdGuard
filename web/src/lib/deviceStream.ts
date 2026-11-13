import { LIMITS, ReadingWindow, type Bucket, type Reading, type TelemetryBatchMsg } from '@coldguard/shared';
import { api } from './api';
import { realtime } from './realtime';
import { ThrottledStore } from './stores';

export type StreamPhase = 'loading' | 'live' | 'paused' | 'reconnecting' | 'catching-up' | 'refresh-required' | 'error';

interface HistoryResponse {
  mode: 'raw' | 'agg';
  from: number;
  to: number;
  watermark: number;
  readings: Reading[];
  buckets?: Bucket[];
  bucketMs?: number;
  aggEnd?: number;
  truncated: boolean;
}

const MAX_LIVE_BUFFER = 20_000;
const MAX_WINDOW = 25_000;

/**
 * History + live controller for one device view.
 *
 * Handoff protocol (race-safe):
 *  1. start buffering live `telemetry` for this device;
 *  2. `realtime.want()` → server joins `device:<id>` and acks;
 *  3. GET history (server reads its commit watermark before querying);
 *  4. merge history ∪ buffer into a ReadingWindow (dedupe by eventId,
 *     deterministic order); switch to direct live insertion.
 *
 * Aggregated mode overlap rule: buckets cover [from, aggEnd); raw readings
 * cover [aggEnd, now]. A live reading with t < aggEnd belongs to an
 * already-aggregated bucket, so it is NOT drawn (it is counted in
 * `stats.lateOutsideAgg` and a refresh will fold it in).
 *
 * Reconnect: on re-subscription, fetch `/since?cursor=<highest cursor seen>`
 * and merge; if the server says the gap is too large, require a refresh.
 */
export class DeviceStream extends ThrottledStore {
  phase: StreamPhase = 'loading';
  following = true; // false = paused (chart frozen; data keeps merging)
  mode: 'raw' | 'agg' = 'raw';
  window = new ReadingWindow({ maxPoints: MAX_WINDOW });
  buckets: Bucket[] = [];
  bucketMs = 0;
  aggEnd = 0;
  from = 0;
  error: string | null = null;
  stats = {
    historyCount: 0,
    bufferedDuringLoad: 0,
    overlapDeduped: 0,
    liveReceived: 0,
    lateFlagged: 0,
    lateOutsideAgg: 0,
    catchUps: 0,
    caughtUpEvents: 0,
    watermark: 0,
    lastCursor: 0,
    loadMs: 0,
  };

  private gen = 0;
  private buffering = true;
  private buffer: Reading[] = [];
  private abort: AbortController | null = null;
  private offs: (() => void)[] = [];
  private disposed = false;
  private reconnecting = false;

  constructor(public deviceId: string, public rangeMs: number) {
    super(250); // chart refresh cadence: 4 Hz, independent of event rate
    this.offs.push(realtime.on('telemetry', (m) => this.onTelemetry(m)));
    this.offs.push(
      realtime.on('status', (s) => {
        if (s === 'reconnecting' || s === 'dropped') {
          this.reconnecting = true;
          this.phase = 'reconnecting';
          this.changedNow();
        }
      }),
    );
    this.offs.push(
      realtime.on('subscribed', (ack, reconnect) => {
        if (reconnect && this.reconnecting && ack.devices.includes(this.deviceId)) void this.catchUp();
      }),
    );
    this.offs.push(
      realtime.on('resync', (m) => {
        if (m.reason === 'server-restart') void this.load();
        else void this.catchUp();
      }),
    );
  }

  async load(rangeMs = this.rangeMs) {
    const gen = ++this.gen;
    this.rangeMs = rangeMs;
    this.abort?.abort();
    const ac = (this.abort = new AbortController());
    this.phase = 'loading';
    this.buffering = true;
    this.buffer = [];
    this.error = null;
    this.changedNow();
    const t0 = performance.now();
    try {
      await realtime.want(`device-view`, { groups: [], devices: [this.deviceId] });
      if (gen !== this.gen || this.disposed) return;
      const to = Date.now() + realtime.clockOffset;
      const from = to - rangeMs;
      const h = await api<HistoryResponse>(`/telemetry/${encodeURIComponent(this.deviceId)}?from=${Math.round(from)}&mode=auto`, { signal: ac.signal });
      if (gen !== this.gen || this.disposed) return;

      const w = new ReadingWindow({ maxPoints: MAX_WINDOW });
      w.insert(h.readings);
      this.mode = h.mode;
      this.buckets = h.buckets ?? [];
      this.bucketMs = h.bucketMs ?? 0;
      this.aggEnd = h.aggEnd ?? 0;
      this.from = h.from;
      const buffered = this.buffer;
      const eligible = this.mode === 'agg' ? buffered.filter((r) => r.t >= this.aggEnd) : buffered;
      const before = w.duplicatesDropped;
      w.insert(eligible);
      this.window = w;
      this.stats = {
        ...this.stats,
        historyCount: h.readings.length + (h.buckets?.reduce((a, b) => a + b.n, 0) ?? 0),
        bufferedDuringLoad: buffered.length,
        overlapDeduped: w.duplicatesDropped - before,
        lateOutsideAgg: buffered.length - eligible.length,
        watermark: h.watermark,
        lastCursor: Math.max(h.watermark, w.maxCursor),
        loadMs: Math.round(performance.now() - t0),
      };
      this.buffer = [];
      this.buffering = false;
      this.reconnecting = false;
      this.phase = this.following ? 'live' : 'paused';
      this.changedNow();
    } catch (e: any) {
      if (e?.name === 'AbortError' || gen !== this.gen) return;
      this.error = e?.message ?? 'failed to load history';
      this.phase = 'error';
      this.changedNow();
    }
  }

  private onTelemetry(m: TelemetryBatchMsg) {
    let mine = 0;
    for (const r of m.events) {
      if (r.d !== this.deviceId) continue; // never leak other devices into this view
      mine++;
      if (r.late) this.stats.lateFlagged++;
      if (this.buffering) {
        if (this.buffer.length >= MAX_LIVE_BUFFER) {
          this.phase = 'refresh-required';
          continue;
        }
        this.buffer.push(r);
        continue;
      }
      if (r.c > this.stats.lastCursor) this.stats.lastCursor = r.c;
      if (this.mode === 'agg' && r.t < this.aggEnd) {
        this.stats.lateOutsideAgg++;
        continue;
      }
      this.window.insert([r]);
    }
    if (!mine) return;
    this.stats.liveReceived += mine;
    if (!this.buffering && this.following) this.window.trimBefore(Date.now() + realtime.clockOffset - this.rangeMs - 5000);
    this.changed();
  }

  /** Fill the gap after a disconnect or a slow-consumer resync from MongoDB. */
  async catchUp() {
    if (this.buffering) return void this.load(); // initial load not finished — just reload
    const gen = this.gen;
    this.phase = 'catching-up';
    this.changedNow();
    try {
      const cursor = this.stats.lastCursor;
      const res = await api<{ readings: Reading[]; truncated: boolean; watermark: number }>(
        `/telemetry/${encodeURIComponent(this.deviceId)}/since?cursor=${cursor}`,
      );
      if (gen !== this.gen || this.disposed) return;
      if (res.truncated) {
        this.phase = 'refresh-required';
        this.changedNow();
        return;
      }
      const eligible = this.mode === 'agg' ? res.readings.filter((r) => r.t >= this.aggEnd) : res.readings;
      this.window.insert(eligible);
      for (const r of res.readings) if (r.c > this.stats.lastCursor) this.stats.lastCursor = r.c;
      this.stats.catchUps++;
      this.stats.caughtUpEvents += res.readings.length;
      this.reconnecting = false;
      this.phase = this.following ? 'live' : 'paused';
      this.changedNow();
    } catch (e: any) {
      this.error = e?.message ?? 'catch-up failed';
      this.phase = 'refresh-required';
      this.changedNow();
    }
  }

  pause() {
    if (!this.following) return;
    this.following = false;
    if (this.phase === 'live') this.phase = 'paused';
    this.changedNow();
  }

  resume() {
    this.following = true;
    if (this.phase === 'paused') this.phase = 'live';
    this.window.trimBefore(Date.now() + realtime.clockOffset - this.rangeMs - 5000);
    this.changedNow();
  }

  dispose() {
    this.disposed = true;
    this.gen++;
    this.abort?.abort();
    this.offs.forEach((f) => f());
    realtime.release('device-view');
  }
}

export const RANGES = [
  { label: '5 min', ms: 5 * 60_000 },
  { label: '15 min', ms: 15 * 60_000 },
  { label: '1 h', ms: 60 * 60_000 },
  { label: '6 h', ms: 6 * 3600_000 },
  { label: '24 h', ms: 24 * 3600_000 },
];

export const MAX_RAW = LIMITS.maxHistoryRawPoints;
