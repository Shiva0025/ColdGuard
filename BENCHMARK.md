# ColdGuard benchmark

All numbers below were **measured on 2026-11-13** with `loadtest/`. The raw JSON for every run is in `loadtest/results/`. Nothing on this page is projected or estimated.

## Environment

| | |
|---|---|
| Machine | Laptop, 12th Gen Intel Core i5-12450H (12 threads), 16 GB RAM, Linux 7.0 x64 |
| Runtime | Node v22.22.1, server run with `tsx` (no watch mode), `NODE_ENV=development` defaults from `.env.example` |
| Database | MongoDB 8.0.38 in Docker (`docker-compose.yml`), default storage settings, same machine |
| Co-located | Load generator, all Socket.IO clients, server and MongoDB share the same CPU. The 500 ev/s run overlapped with a Docker image build. |
| Server config | `QUEUE_CAPACITY=20000`, `DB_BATCH_MAX=1000`, `TELEMETRY_EMIT_MS=250`, `FLEET_EMIT_MS=1000`, `AGENT_RATE_EPS=5000` (raised to 100000 only for the capacity runs) |

## What is measured (boundaries)

| Metric | From → to | Clock |
|---|---|---|
| **Ingest ack latency** | load generator sends HTTP request → receives `200` that confirms **durable** persistence | generator (one clock) |
| **Delivery latency** | server `receivedAt` (set when the HTTP request arrives) → Socket.IO client receives the reading | same machine ⇒ same clock; no cross-machine skew |
| **Server pipeline** | `receivedAt` → `io.emit` on the server (includes queueing, DB write, batching window) | server |
| **DB batch** | `insertMany` call → resolution | server |
| **Delivery completeness** | for every reading that MongoDB stored for a subscribed device during the run (queried afterwards by cursor), did every subscribed client receive it? | — |

In the browser, the investigation view shows delivery latency corrected by an NTP-style clock-offset estimate (uncertainty ±RTT/2), so it stays meaningful across machines.

Each client subscribes to **5 device rooms** (raw telemetry) plus the **stress group room** (1 s fleet deltas of changed devices). Readings are spread round-robin over N stress loggers. Warm-up samples are discarded.

## Commands

```bash
npm run db:up && npm start                      # server only (simulator not needed; the test pauses it)
npm run loadtest -- --rate 500  --clients 10 --duration 45 --warmup 10 --label r500-c10
npm run loadtest -- --rate 1000 --clients 20 --duration 60 --warmup 10 --label r1000-c20
npm run loadtest -- --rate 4000 --clients 20 --duration 45 --warmup 10 --label r4000-c20
npm run loadtest -- --rate 1000 --clients 20 --duration 20 --warmup 5 --burst-rate 9000 --burst-sec 15 --recovery 20 --label burst9000
# capacity search: restart the server with AGENT_RATE_EPS=100000
npm run loadtest -- --rate 8000  --clients 20 --duration 30 --warmup 8 --concurrency 8 --batch 500 --label cap-r8000
npm run loadtest -- --rate 15000 --clients 20 --duration 30 --warmup 8 --concurrency 8 --batch 500 --label cap-r15000
npm run loadtest -- --rate 30000 --clients 20 --duration 30 --warmup 8 --concurrency 8 --batch 500 --label cap-r30000
```

## Results: steady state

| Run | Offered ev/s | Persisted ev/s | Ingest ack p50 / p95 / p99 | Delivery p50 / p95 / p99 | Server pipeline p95 | DB batch p95 (avg size) | Max queue | 503 / 429 | CPU avg / max | RSS max | Loop p99 max | Delivery completeness |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 500 × 10 clients, 45 s | 499 | 499 | 23.7 / 28.1 / 36.9 ms | 82 / 112 / 117 ms | 126 ms | 7.2 ms (50) | 50 | 0 / 0 | 7.9 / 12.9 % | 175 MB | 13.6 ms | **3,000 / 3,000** |
| **1,000 × 20 clients, 60 s** (stretch target) | 995 | 995 | 26.0 / 42.2 / 69.8 ms | 101 / 252 / 258 ms | 220 ms | 6.6 ms (100) | 100 | 0 / 0 | 9.2 / 13.4 % | 188 MB | 15.7 ms | **7,500 / 7,500** |
| 4,000 × 20, 45 s | 3,920 | 3,929 | 40.9 / 95.3 / 118.4 ms | 108 / 254 / 282 ms | 231 ms | 16.5 ms (400) | 400 | 0 / 0 | 19.4 / 27.3 % | 203 MB | 22.9 ms | 11,900 / 11,900 |
| 8,000 × 20, 30 s* | 7,866 | 7,866 | 62.3 / 105.3 / 124.8 ms | 109 / 291 / 309 ms | — | 44.8 ms (800) | 800 | 0 / 0 | 27.3 / 33.3 % | 286 MB | 26.2 ms | 19,200 / 19,200 |
| 15,000 × 20, 30 s* | 14,900 | 14,950 | 53.1 / 97.9 / 128.5 ms | 170 / 301 / 319 ms | — | 41.1 ms (633) | 1,500 | 0 / 0 | 32.9 / 48.3 % | 425 MB | 26.3 ms | 36,200 / 36,200 |
| 30,000 × 20, 30 s* | 28,999 | **14,500 (saturated)** | 270 / 341 / 388 ms | 376 / 517 / 561 ms | 493 ms | 53.3 ms (1000) | 3,000 | 0 / 0 | 63.6 / 85.5 % | 520 MB | 59.3 ms | 48,900 / 48,900 of stored |

\* Per-agent rate limit raised to 100,000 ev/s to find the server's capacity instead of the protection threshold.

Totals (offered = persisted acknowledged, with zero local drops) for the 500, 1,000, 4,000, 8,000 and 15,000 runs: 29,900 / 74,600 / 234,800 / 378,400 / 714,000 events, all persisted exactly once.

## Results: burst, back-pressure and recovery

`burst9000`: 1,000 ev/s steady, then **9,000 ev/s for 15 s** (above the 5,000 ev/s per-agent limit), then 20 s back at 1,000 ev/s.

- The server answered **29 requests with 429 + Retry-After**. There were no 503s, because the token bucket engages before the queue fills.
- The load generator's `IngestClient` backed off (exponential, jittered, honouring Retry-After). Its bounded outbox held **50,904 events** at the end of the burst.
- During recovery the backlog drained using the spare capacity. All **178,700 offered events were persisted exactly once** (0 duplicates stored, 0 local drops). Delivery completeness was **17,900 / 17,900**.

## Observed limit and bottleneck

At 30,000 ev/s offered, the server sustained **≈14,500 ev/s durable**. The rest accumulated in the generator's bounded outbox, which overflowed and **dropped 564,000 events locally**. Those drops were counted by the client (`droppedLocal`), never sent, and never reported as persisted. The server's own queue stayed ≤ 3,000 of 20,000. The generator's bounded concurrency (8 × 500 events in flight) acted as back-pressure, so no 503s were needed. After the load stopped, the outbox drained in 13.9 s.

Bottleneck: the **single ordered writer**. At saturation each `insertMany` of 1,000 documents took ≈50 ms, with 4 indexes maintained per document. That caps one writer at roughly 15–20k docs/s on this machine. Server CPU was 64 % average, and the load generator and MongoDB compete for the same cores.

Realistic next improvement: 2–4 pipelined writers with a "minimum contiguous committed cursor" watermark. Alternatively, partition devices across writers with per-partition cursors. Either keeps the history/live proof intact.

## Browser responsiveness and chart cadence

- Stores notify React at most every 250 ms, so the chart redraws ≤ 4 times per second however fast readings arrive. The investigation page's integrity panel shows the actual render count next to the number of live readings received.
- In the Playwright run (`npx playwright test`) the operator view stayed interactive throughout: zoom, pause, resume, acknowledge and disconnect/reconnect all responded within the test's default timeouts, with no page errors. This was at the default demo rate (24 loggers, 1 Hz).
- **Not measured:** browser frame timing or long-task statistics under the 1,000 ev/s load test. The load-test clients are Node Socket.IO clients, not browsers.

## Reconnection recovery

- Integration test `catches up from MongoDB after a disconnect using the cursor`: a 15-event gap while disconnected, plus 5 live events after reconnecting, merged into exactly seq 0–29.
- End-to-end test: **Drop connection** in the UI (a real socket disconnect for 8 s) → Reconnecting → Live, with the catch-up counter > 0 and no duplicates.

## Re-check after the signature features (evidence chain, commands, budget)

Same laptop. Server running under `npm run dev` (tsx watch), with the evidence chain hashing and sealing every reading:

| Run | Offered / persisted | Ingest ack p50 / p95 / p99 | Delivery p50 / p95 / p99 | DB batch p95 | CPU avg / max | RSS max | Completeness |
|---|---|---|---|---|---|---|---|
| 1,000 × 20, 30 s | 993 / 996 ev/s | 31 / 65 / 81 ms | 140 / 233 / 240 ms | 9 ms | **25 % / 89 %** | 176 MB | 4,300 / 4,300 |
| 4,000 × 20, 30 s | 3,907 / 3,893 ev/s | 48 / 94 / 112 ms | 166 / 235 / 296 ms | 21 ms | 38 % / 80 % | 245 MB | 8,500 / 8,500 |

Throughput, latency and completeness are unchanged, but **server CPU at 1,000 ev/s rose from 9 % to 25 % average**. The likely contributors are per-reading SHA-256 leaves, per-device block seals (≈ 100 inserts/s with 1,000 devices sealing every 10 s), and the dev-mode server. The CPU maxima include the burst of ~1,000 stress-device offline incidents that opens when the load generator stops. These were not profiled separately; the original capacity runs above predate the evidence chain.
