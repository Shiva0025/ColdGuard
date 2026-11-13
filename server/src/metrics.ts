import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Fixed-size sample reservoir for latency percentiles (bounded memory). */
export class Reservoir {
  private buf: Float64Array;
  private n = 0;
  private i = 0;
  constructor(size = 4096) {
    this.buf = new Float64Array(size);
  }
  add(v: number) {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
  }
  percentiles(ps: number[]): (number | null)[] {
    if (this.n === 0) return ps.map(() => null);
    const a = Array.from(this.buf.subarray(0, this.n)).sort((x, y) => x - y);
    return ps.map((p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]);
  }
  reset() {
    this.n = 0;
    this.i = 0;
  }
}

/** Sliding-window rate counter with 1 s buckets. */
export class RateCounter {
  private buckets = new Map<number, number>();
  total = 0;
  constructor(private windowSec = 5) {}
  add(n = 1) {
    if (n <= 0) return;
    this.total += n;
    const s = Math.floor(Date.now() / 1000);
    this.buckets.set(s, (this.buckets.get(s) ?? 0) + n);
    if (this.buckets.size > this.windowSec + 2) {
      for (const k of this.buckets.keys()) if (k < s - this.windowSec - 1) this.buckets.delete(k);
    }
  }
  /** Average per-second over the last `windowSec` complete seconds. */
  rate(): number {
    const s = Math.floor(Date.now() / 1000);
    let sum = 0;
    for (let k = s - this.windowSec; k < s; k++) sum += this.buckets.get(k) ?? 0;
    return sum / this.windowSec;
  }
}

export class ProcessSampler {
  private eld = monitorEventLoopDelay({ resolution: 10 });
  private lastCpu = process.cpuUsage();
  private lastAt = performance.now();
  private cpuPct = 0;
  private loopP99 = 0;
  private timer: NodeJS.Timeout;
  constructor() {
    this.eld.enable();
    this.timer = setInterval(() => this.sample(), 2000);
    this.timer.unref();
  }
  private sample() {
    const now = performance.now();
    const cpu = process.cpuUsage(this.lastCpu);
    this.cpuPct = ((cpu.user + cpu.system) / 1000 / (now - this.lastAt)) * 100;
    this.lastCpu = process.cpuUsage();
    this.lastAt = now;
    this.loopP99 = this.eld.percentile(99) / 1e6;
    this.eld.reset();
  }
  snapshot() {
    const m = process.memoryUsage();
    return {
      rssMb: Math.round(m.rss / 1048576),
      heapMb: Math.round(m.heapUsed / 1048576),
      cpuPct: Math.round(this.cpuPct * 10) / 10,
      eventLoopP99Ms: Math.round(this.loopP99 * 10) / 10,
      uptimeSec: Math.round(process.uptime()),
    };
  }
  stop() {
    clearInterval(this.timer);
    this.eld.disable();
  }
}
