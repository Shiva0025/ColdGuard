import { platform, useStore } from '../lib/stores';
import { realtime } from '../lib/realtime';
import { fmtInt, fmtMs } from '../lib/format';
import { Stat } from '../components/bits';

function MiniBars({ values, color, label }: { values: number[]; color: string; label: string }) {
  const max = Math.max(1, ...values);
  return (
    <svg viewBox={`0 0 ${values.length * 4} 40`} className="h-10 w-full" preserveAspectRatio="none" role="img" aria-label={label}>
      {values.map((v, i) => (
        <rect key={i} x={i * 4} y={40 - (v / max) * 38} width={3} height={(v / max) * 38} fill={color} />
      ))}
    </svg>
  );
}

export function PlatformPage() {
  useStore(platform);
  const m = platform.latest;
  const h = platform.history;
  if (!m) return <div className="text-sm text-ink-3">Waiting for the first platform metrics message…</div>;
  const t = m.ingest.totals;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Platform health</h1>
        <p className="mt-1 max-w-3xl text-xs text-ink-3">
          Everything on this page is <b>measured</b> by the running server (pushed once per second over the <code>platform</code> room) or by this
          browser tab. It is separate from the <b className="text-sim">simulated</b> shipment telemetry.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Persisted / s" value={fmtInt(m.ingest.persistedPerSec)} sub="5 s window">
          <MiniBars values={h.map((x) => x.persisted)} color="#0891b2" label="persisted per second, last 2 minutes" />
        </Stat>
        <Stat label="Server pipeline p95" value={fmtMs(m.pipeline.p95)} sub={`p50 ${fmtMs(m.pipeline.p50)} · p99 ${fmtMs(m.pipeline.p99)} · receivedAt → emit`}>
          <MiniBars values={h.map((x) => x.pipelineP95)} color="#d97706" label="pipeline p95 per second" />
        </Stat>
        <Stat label="Ingest queue" value={`${fmtInt(m.queue.depth)} / ${fmtInt(m.queue.capacity)}`} tone={m.queue.overloaded ? 'text-crit' : ''} sub={m.queue.overloaded ? 'shedding load: 503 + Retry-After' : 'bounded; admission all-or-nothing'} />
        <Stat label="DB batch p95" value={fmtMs(m.db.batchP95)} sub={`p50 ${fmtMs(m.db.batchP50)} · last batch ${m.db.lastBatchSize} docs`} />
        <Stat label="Sockets" value={m.sockets.connected} sub={`${m.sockets.lagging} lagging (excluded until resync)`} />
        <Stat label="Socket deliveries / s" value={fmtInt(m.sockets.emittedPerSec)} sub="events × recipients" />
        <Stat label="Server CPU / RSS" value={`${m.process.cpuPct}% · ${m.process.rssMb} MB`} sub={`heap ${m.process.heapMb} MB · up ${m.process.uptimeSec}s`} />
        <Stat label="Event-loop delay p99" value={fmtMs(m.process.eventLoopP99Ms)} sub="perf_hooks monitor" />
      </div>
      <section className="panel p-4">
        <h2 className="text-sm font-semibold">Ingestion counters since server start</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:grid-cols-8">
          {(
            [
              ['Offered', t.offered],
              ['Accepted', t.accepted],
              ['Persisted', t.persisted],
              ['Duplicates', t.duplicates],
              ['Late', t.late],
              ['Rejected (invalid)', t.rejected],
              ['Overload 503', t.overload],
              ['Rate limited 429', t.rateLimited],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="label">{k}</dt>
              <dd className="text-lg font-semibold tabular">{fmtInt(v)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="panel p-4 text-sm">
        <h2 className="text-sm font-semibold">This tab</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <dt className="label">Delivery p50 / p95</dt>
            <dd className="font-semibold tabular">
              {fmtMs(realtime.deliveryMs.pct(50))} / {fmtMs(realtime.deliveryMs.pct(95))}
            </dd>
          </div>
          <div>
            <dt className="label">Samples</dt>
            <dd className="font-semibold tabular">{fmtInt(realtime.deliveryMs.count)}</dd>
          </div>
          <div>
            <dt className="label">Socket RTT · clock offset</dt>
            <dd className="font-semibold tabular">
              {fmtMs(realtime.rtt)} · {Math.round(realtime.clockOffset)} ms
            </dd>
          </div>
          <div>
            <dt className="label">Reconnects</dt>
            <dd className="font-semibold tabular">{realtime.reconnects}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-ink-3">
          Delivery latency = server <code>receivedAt</code> → receipt in this tab, corrected by an NTP-style clock offset from the lowest-RTT probe;
          uncertainty ≈ ± RTT/2. Samples exist only while a logger investigation view is open (only device rooms carry raw readings).
        </p>
      </section>
    </div>
  );
}
