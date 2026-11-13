# Submission checklist

## Problem-statement requirements → implementation → evidence

| Requirement (MERNIFY PDF) | Implementation | Evidence |
|---|---|---|
| Ingest continuous streams from multiple sources | `POST /api/ingest/batch`; simulator with 24–2000 loggers | `server/src/routes.ts`, `simulator/`; demo 0:00 |
| Process events, maintain system state | In-order state engine, statuses, alert state machines | `server/src/engine.ts`; `alerts.test.ts` |
| Store telemetry for history | MongoDB `telemetry`, indexes, TTL retention | `server/src/db.ts`; ARCHITECTURE §5 |
| Broadcast relevant updates in real time | Socket.IO group/device/alerts rooms, batched deltas | `broadcaster.ts`; `realtime.test.ts › delivers only relevant updates` |
| Interactive visualisations | Lane board, sparklines, uPlot chart with bands/markers/zoom, platform bars | screenshots; demo 1:10–2:55 |
| History alongside live, no duplicates/inconsistency | Watermark handoff + eventId merge; raw/agg boundary | `realtime.test.ts › history + live`; ARCHITECTURE §4 |
| Responsive under frequent updates | Throttled stores, bounded buffers, virtualised list, memo rows | ARCHITECTURE §9; BENCHMARK |
| Node + Express backend | Express 5 | `server/` |
| MongoDB | Official driver, aggregation, unique/partial/TTL indexes | `server/src/db.ts` |
| React frontend | React 19 + Vite + TS | `web/` |
| Socket.IO integral to live delivery | All live data (telemetry, fleet, incidents, metrics) | `socket.ts`, `broadcaster.ts` |
| Simulated data sources | Seeded thermal-model simulator, separate process | `simulator/` |
| Batching / throttling / aggregation | Ingest batches, DB batches, emit windows, query-time buckets | TEAM_NOTES |
| Rooms / namespaces | Rooms per group/device/alerts/platform; `/agent` namespace | `socket.ts` |
| Source, event id, timestamp; duplicates / out-of-order | eventId, deviceId, sessionId, seq, observedAt, receivedAt, cursor | `shared/src/schemas.ts`; `ingest.test.ts` |
| Input validation + rate limiting | zod, size/batch caps, ranges, time window; token bucket, login and subscribe limits | `ingest.test.ts` |
| Authentication + access control | bcrypt + JWT, roles, group scopes, agent keys | `ingest.test.ts`, `realtime.test.ts` |
| Clean, meaningful UI | Operations dashboard, explained alerts | screenshots, demo |

## Signature features

| Feature | Evidence |
|---|---|
| Interactive rescue + simulated comparison | `commands.test.ts`; live run in TEST_RESULTS §7 |
| Incident replay with possible contributing factors | `replay.test.ts`; replay screenshots |
| Break-the-network integrity panel | `e2e/network-check.mjs` run (TEST_RESULTS §7) |
| Judges join by QR (phones as trucks) | `guest.test.ts`; `e2e/judge-check.mjs` run |
| Heat-exposure budget | `alerts.test.ts › integrates heat exposure…` |
| Tamper-evident evidence chain + offline-verifiable report | `evidence.test.ts` (incl. CLI verify/fail) |

## Bonus criteria

| Bonus | Status | Evidence |
|---|---|---|
| High-frequency streams with low latency | ✅ 1,000 ev/s × 20 clients at 9 % CPU; saturation ≈14.5k ev/s | BENCHMARK.md |
| Optimised payloads, selective broadcast | ✅ compact keys, changed-only versioned deltas, rooms only filled when watched | `broadcaster.ts` |
| Client batching / throttling / windowing | ✅ | `stores.ts`, `deviceStream.ts` |
| Independent subscriptions / filtering | ✅ | `realtime.test.ts`, e2e |
| Historical analysis with live | ✅ ranges to 24 h, buckets + raw tail | investigation view |
| Anomaly detection + alerts | ✅ excursion, drift, offline, battery; hysteresis; ack | `alerts.test.ts` |
| Backpressure / rate limiting | ✅ 429/503 + Retry-After, client backoff, slow-client resync | `ingest.test.ts`, burst benchmark |
| Performance measurements | ✅ events and clients stated, JSON results | BENCHMARK.md, `loadtest/results/` |
| Hosting | ⏳ prepared (Dockerfile, render.yaml), **not deployed** | — |

## Deliverables

- [x] Working application (local), at least one data source, live dashboard, Socket.IO, history + live
- [x] README with every required section (overview, setup, features, stack, data generation, real-time mechanism, run/test, attribution)
- [x] ARCHITECTURE.md (system and data-flow diagrams, schema, real-time mechanism, optimisations)
- [x] TEST_RESULTS.md, BENCHMARK.md, DEMO_SCRIPT.md, ATTRIBUTION.md, TEAM_NOTES.md
- [x] `.env.example`, lockfile, seed script, docker-compose, Dockerfile, render.yaml
- [ ] **Git commits + push to GitHub**: the repo is initialised, but nothing has been committed yet. Commit during the event under your own names (see below).
- [ ] **Demo video (3–5 min)**: follow DEMO_SCRIPT.md, then upload it.
- [ ] **Deployment (optional bonus)**: Atlas cluster + Render (or Railway) using `render.yaml`; set the secrets in the dashboard.
- [ ] Fill in team names / submission form.

## Remaining actions, in order

1. `git add -A && git commit -m "ColdGuard: real-time cold-chain telemetry"` (check `git status` first; `.env` is ignored). Create the GitHub repo and push.
2. Record the video following DEMO_SCRIPT.md (reset demo data first).
3. Optional: deploy. Create a MongoDB Atlas free cluster, then a new Render Blueprint pointing at the repo. Set `MONGO_URL`, `AGENT_KEY` (`sim-agent.<openssl rand -hex 24>`), `DEMO_PASSWORD` and `CORS_ORIGIN`. Check `/api/healthz`, then add the URL to the README.
4. Submit the repo link, video link and (optional) deployment URL.

## Known issues (honest list)

- `npm audit --omit=dev` reports **GHSA-mrhx-c7xc-m3w5** for zod 3.x (memory exhaustion when validating oversized collections). Every zod-validated input is size-capped first (HTTP bodies 4 KB–512 KB, ingest batches ≤ 500 events, Socket.IO messages ≤ 64 KB), which limits exposure. The real fix is upgrading to zod ≥ 4.6.6; it has not been done or tested yet.
- Server CPU at 1,000 ev/s rose from ~9 % to ~25 % after the evidence chain was added (not profiled; see BENCHMARK.md).
- Phone joining was verified with a Pixel 7 emulation in headless Chrome, not with real phones on a venue network.
- The evidence chain proves integrity since sealing within one deployment; it cannot prove sensor truthfulness, or stop someone controlling the server from re-sealing.
