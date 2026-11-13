# ColdGuard — implementation plan

Track: MERNIFY "High-Throughput Streams & Telemetry". Domain: simulated vaccine cold-chain
(refrigerated shipments + storage facilities). All values, thresholds and inventory exposure are
**simulated demo settings**, not medical guidance.

## Requirement → feature checklist

| Problem-statement requirement | ColdGuard feature |
|---|---|
| Ingest continuous streams from multiple sources | Authenticated `POST /api/ingest/batch` from a separate simulator process (N devices, seeded) |
| Process events, maintain system state | In-order device-state engine (session/seq ordering), status calc, alert state machine |
| Store telemetry for history | MongoDB `telemetry` collection, unique `_id = eventId`, `(d,s,q)` unique, `(d,t)` + `(d,c)` indexes, TTL retention, 1-min rollups |
| Broadcast relevant updates in real time | Socket.IO rooms `device:<id>`, `group:<id>`, batched deltas every 250 ms |
| Interactive visualisations | Fleet lane board, sparklines, uPlot investigation chart with threshold bands + alert markers |
| History alongside live w/o duplicates | Subscribe-then-snapshot with commit-cursor watermark + eventId dedupe merge |
| Responsive under frequent updates | Client store with 4 Hz render cadence, bounded ring buffers, virtualised list |
| Rooms / namespaces | Default namespace for users (group + device rooms, authorised), `/agent` namespace for simulator control |
| Event identity / timestamps / dup + out-of-order | `eventId`, `deviceId`, `sessionId`, `seq`, `observedAt`, server `receivedAt`, server commit cursor `c` |
| Validation + rate limiting | zod schemas (shared), body size cap, batch cap, metric ranges, clock skew window, per-agent token bucket, login limiter |
| Auth + access control | bcrypt users (operator / viewers by group), JWT for REST + Socket.IO, hashed agent keys scoped to groups |
| Anomaly detection + alerts (bonus) | Sustained excursion, rapid drift, offline, low battery; hysteresis recovery; dedupe; ack with user+time |
| Backpressure (bonus) | Bounded queue → 503 + Retry-After; simulator exponential backoff + jitter; slow-client lagging room + resync |
| Perf measurements (bonus) | `loadtest/` with configurable event rate + client count, server metrics endpoint, BENCHMARK.md |
| Hosting (bonus) | Dockerfile + render.yaml (long-lived Node process), Atlas connection |
| README / architecture / demo | README, ARCHITECTURE.md, TEST_RESULTS.md, BENCHMARK.md, DEMO_SCRIPT.md, SUBMISSION_CHECKLIST.md |

## Layout (npm workspaces)

- `shared/` — zod schemas, types, constants, ordering/merge helpers (used by server, web, simulator)
- `server/` — Express + Socket.IO + MongoDB driver
- `web/` — React + Vite + TS + Tailwind
- `simulator/` — seeded device fleet that talks to the real ingest API, controlled over `/agent`
- `loadtest/` — load generator + N socket clients + metrics capture

## Build order (vertical slices)

1. Mongo + ingest + simulator + one live chart
2. Persistence + history + race-safe merge
3. Independent subscriptions + reconnect catch-up
4. Incidents + acknowledgement
5. Polished overview / investigation / control screens
6. Load protection + benchmark
7. Docs + demo script

## Assumptions

- Single backend instance (documented scaling limits; Socket.IO adapter would be needed for >1).
- Per-tab session (token in `sessionStorage`) so two users can be demoed side by side in one browser.
- Thresholds default to a 2–8 °C demo band; editable by operator.

## Status (2026-11-13)

All seven slices are implemented and verified: 36 automated tests, a Playwright E2E run, Docker image smoke test, and benchmarks.
Remaining: git commit/push, demo video, optional deployment. See SUBMISSION_CHECKLIST.md.
