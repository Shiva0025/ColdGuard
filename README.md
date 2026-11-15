# ColdGuard — real-time cold-chain telemetry

> **MERNIFY · High-Throughput Streams & Telemetry.** A real-time operations dashboard for a **simulated** fleet of refrigerated vaccine shipments and cold rooms, built on MongoDB, Express, React, Node.js and Socket.IO.

> **A cold-chain dashboard tells you something went wrong. ColdGuard helps you reconstruct the incident, test a response and preserve the evidence — even when connectivity fails.**

You can watch a cold-chain incident develop live, send a rescue command and see its effect in the telemetry, replay how it happened, and prove the stored evidence was not altered. Independent users receive only the updates relevant to them, even under load, and **the judges can join from their phones**: each phone becomes a truck that streams through the real pipeline.

> ⚠️ Everything domain-specific is simulated: shipments, temperatures, dose counts, ₹ values, and the 2–8 °C thresholds. The thresholds are **configurable demonstration settings**, not vaccine-storage guidance. ColdGuard is not a medical or regulatory decision system.

---

## 1. Problem and story

Cold-chain operators watch dozens of refrigerated loggers. When a compressor fails, the temperature starts *drifting* well before it breaches the safe band. By the time a simple threshold alarm fires, the stock may already be compromised. Meanwhile the data keeps streaming, and the operator has to investigate one shipment without losing sight of the rest.

ColdGuard covers that workflow end to end: healthy trucks stream → the judges join from their phones → a door is left open and the compressor fails → an explained alert fires → the truck loses signal while it keeps buffering → the operator's rescue command waits for the signal → on reconnect the command is applied, the missing history is backfilled without duplicates, and the cooling recovery shows in the telemetry → the incident is replayed → the evidence is verified and tampering is caught.

The underlying flow:

1. **Healthy live monitoring.** Fleet overview, lane board, sparklines and status counts update live.
2. **Cooling failure injected.** The temperature rises at ≈3 °C/min.
3. **Early warning.** A *rapid drift* alert fires while the logger is still inside 2–8 °C.
4. **Critical excursion.** After the breach has lasted the configured time, an explained incident opens. It names the first breaching reading, the peak, the rule, and the cooling-unit state.
5. **Investigation.** The operator opens the shipment, zooms into the breach, and live data keeps merging while the chart is paused. They then acknowledge the incident with a note (user and time are recorded).
6. **Recovery.** Cooling is restored. The incident resolves only after the temperature stays inside the hysteresis band for the recovery window, so it doesn't flicker.
7. **Disconnect.** The operator drops the connection; on reconnect the view catches up from MongoDB by cursor, with no gaps and no duplicates.
8. **Under load.** Measured at 1,000 ev/s with 20 Socket.IO clients (and much higher; see [BENCHMARK.md](BENCHMARK.md)).

## 2. Features

### Signature features

| Feature | What you see | How it is real |
|---|---|---|
| **Interactive rescue** | Operator sends *Close compartment*, *Activate backup cooling* or *Restore primary cooling*. Each command moves through **Requested → Delivered → Applied by truck → Confirmed in telemetry**, and shows "queued — truck offline" while the truck has no signal | Commands travel over Socket.IO to the simulator (or to a judge's phone), which really changes its thermal model. "Confirmed" is decided only from persisted, in-order readings (door sensor closed, cooling state, ≥ 0.3 °C drop), never from the device's word |
| **Simulated comparison** | Dashed line: the same thermal model cloned at the moment the command was applied, continued *without* it. Solid line: the observed telemetry. Minutes outside range and heat-budget use for each | Clearly labelled as a simulated what-if: not a forecast, not proof of stock saved |
| **Incident replay** | "Replay incident" with a draggable/playable timeline that syncs the chart, door/cooling state, truck position on its route, heat exposure and the story ("door opened", "humidity rising", "temperature began climbing", "first breach", alert, ack, commands, back in range) | Deterministic rules over stored readings. **Possible contributing factors** (door opening, compressor fault) list their evidence and timing and carry an explicit "correlation, not proof of cause" caveat. If nothing explains the rise, it says so |
| **Break the network** | Per-truck *Cut signal / Restore signal / Delay + reorder / Duplicate deliveries*, with a **live integrity panel**: unique events persisted, duplicates rejected, late readings stored, backfilled readings, events awaiting delivery on the truck, commands waiting for signal, catch-up progress bar, latest-reading age, and chart-duplicate count | Real faults in the simulator's uplink (store-and-forward buffer, delayed and duplicated sends). Counts come from MongoDB, the ingest pipeline, the simulator's uplink report, and the browser's merge buffer |
| **Judges join by QR** | The operator shows a QR code; each phone claims a truck (`GT-01…12`), runs the thermal model locally and streams 1 Hz telemetry. On the phone: open/close door, break/repair compressor, drive into a tunnel. Operator commands arrive on the phone ("Operator: close compartment ✓") | Phones use a short-lived driver token scoped to one truck, the same validated ingest API (own rate limit), and the same command lifecycle. Readings buffered in the tunnel are uploaded on exit and slotted in by observed time |
| **Heat-exposure budget** | Per-truck °C·min outside the band (bar in the list, card on the investigation page, value in replay, reports and the rescue comparison). A critical incident fires when the configurable budget (default 20 °C·min) is spent; recovery never refunds it | Trapezoid integral over in-order readings; gaps > 60 s are not integrated (unknown, not assumed). A demo calculation inspired by vial heat indicators, **not a stability determination** |
| **Tamper-evident evidence** | "Evidence chain: intact" per truck; a demo button lowers the hottest stored reading by 3 °C directly in MongoDB, and verification then names the exact block and event id. **Evidence report** page (print/PDF) plus a JSON export | Readings are sealed in commit order into SHA-256 blocks (≤ 60 readings or 10 s) holding per-reading leaf hashes and a link to the previous block. `npm run verify-report -- file.json` re-verifies a report offline from the file alone |

### Core platform

| Area | Implemented |
|---|---|
| Operations overview | Live logger counts (healthy/warning/critical/offline/awaiting data); "what needs attention" banner; simulated exposure at risk; lane board (schematic map, offline, no paid tiles); virtualised, searchable, filterable shipment list with 3-min sparklines, last-seen, humidity, battery and cooling state; open-incident panel; measured platform-health strip |
| Investigation | Temperature chart with threshold band, units and labels; min/avg/max buckets for long ranges; humidity and battery chart; cooling-fault strip; late readings highlighted; alert / ack / resolve markers; ranges from 5 min to 24 h; **Live / Paused / Reconnecting / Catching up / Refresh required** states; drag-to-zoom without snapping back to live; **Resume live**; stream-integrity panel |
| Incidents | Sustained excursion (high/low), rapid drift (least-squares slope), sensor offline (server clock), low battery; human-readable explanations built from actual readings and rules; one active incident per logger+rule (memory + partial unique index); hysteresis + recovery time; acknowledgement with user, time and note (operator only); timeline |
| Demo control centre | Start/stop simulator; 1–2000 loggers; 100 ms–2 s interval; inject cooling failure, sensor dropout (store-and-forward), low battery, duplicate delivery, out-of-order delivery; restore; editable alert rules; protected, typed-confirmation demo reset |
| Platform health | Ingest/persist rates, bounded queue depth, DB batch latency, server pipeline latency, socket count and lagging sockets, CPU/RSS/event-loop delay, ingestion counters, per-tab delivery latency with clock-offset correction. All measured and labelled separately from simulated telemetry |
| Security | bcrypt users (operator, two corridor viewers), HS256 JWT for REST and Socket.IO, room-join authorisation, separate hashed ingest credential for agents, zod-validated config, CORS allow-list, helmet CSP, login and subscription rate limits, per-agent token bucket, no secrets in the repo |

## 3. Tech stack

- **MongoDB 8** (official Node driver): telemetry, incidents, users, devices, state snapshots, settings
- **Express 5 + Node 22 + TypeScript** (run with `tsx`): REST, ingestion, static hosting
- **Socket.IO 4.8**: authenticated rooms for groups, devices and alerts, a platform room, and an `/agent` control namespace
- **React 19 + Vite 7 + TypeScript + Tailwind CSS 4**: UI. **uPlot** for charts, **TanStack Virtual** for the list, **lucide-react** icons, **qrcode** for invites
- **zod**: one set of schemas shared by server, client, simulator and load test (`shared/`)
- **Vitest** (integration tests against real MongoDB and Socket.IO) and **Playwright** (end-to-end in Chrome)

## 4. Run it

Prerequisites: Node ≥ 20.19 (tested on 22.22), Docker (for MongoDB).

```bash
cp .env.example .env        # dev defaults; change secrets for anything shared
npm install
npm run demo                # = docker compose up -d mongo && npm run seed && npm run dev
```

Then open **http://localhost:5173**:

| User | Password | Sees |
|---|---|---|
| `operator` | `coldguard-demo` (from `DEMO_PASSWORD`) | all corridors; acknowledges incidents; Control centre |
| `viewer.deccan` | same | Deccan corridor only, read-only |
| `viewer.western` | same | Western corridor only, read-only |

Sessions are per browser tab, so you can sign in as two different users in two tabs side by side.

`npm run dev` runs three processes: the API on :4000, Vite on :5173, and the **simulator**, which is a separate process that talks to the real ingest API.

**Single container (production-like):**

```bash
docker compose --profile app up --build   # app on http://localhost:4000, simulator auto-spawned
```

## 5. Test it

```bash
npm run typecheck                        # all five workspaces
npm test                                 # shared unit tests + server integration tests (needs Mongo on :27027)
npx playwright test                      # end-to-end demo flow; needs `npm run dev` running and Chrome
npm run loadtest -- --rate 1000 --clients 20 --duration 60
npm run verify-report -- coldguard-report-<incident>.json   # offline evidence verification
```

**Phones (judges join):** run `npm run dev` on a machine on the venue Wi-Fi (Vite listens on all interfaces). Then Control centre → *Judges join by QR* → *Create invite*, pick the LAN address, and show the QR code. If the venue Wi-Fi isolates clients and phones cannot reach that address, press **Open public link** in the same panel: the server starts a public tunnel (`cloudflared` if installed, otherwise `ngrok`) and the QR code switches to the public HTTPS URL, which also works over mobile data.

Results with actual outputs are in [TEST_RESULTS.md](TEST_RESULTS.md) and [BENCHMARK.md](BENCHMARK.md).

## 6. Data generation and ingestion

**Simulator** (`simulator/`): a seeded (mulberry32) fleet of thermal models. Heat leaks in from a 26–32 °C ambient, and a thermostat cycles the compressor between 3.8 and 5.6 °C, giving a realistic sawtooth. Humidity is correlated with temperature, battery drains slowly, and shipments report route progress. A *cooling failure* stops the compressor and worsens insulation, giving a ≈3 °C/min rise. *Restore* boosts cooling until the logger is back in band. Faults are injected from the Control centre over the `/agent` Socket.IO namespace. That namespace is a control plane only: readings always go through HTTP ingestion.

**Event schema** (validated by zod in `shared/src/schemas.ts`):

```json
{ "eventId": "DC-S03:b1x9:812", "deviceId": "DC-S03", "sessionId": "b1x9", "seq": 812,
  "observedAt": 1794544590578,
  "metrics": { "tempC": 5.49, "humidityPct": 46.5, "batteryPct": 64.4, "cooling": "on", "routeProgress": 0.067 } }
```

The server adds `receivedAt` (server clock) and `c`, a monotonic commit cursor.

**Ingestion pipeline** (`POST /api/ingest/batch`, `Authorization: Agent <id>.<secret>`):

1. Body ≤ 512 KB and ≤ 500 events. Each event is validated for strict schema, metric ranges, a timestamp window (≤ 30 s in the future, ≤ 6 h late), device existence, and that the agent is allowed for the device's group. Invalid events are rejected individually and reported by index.
2. Per-agent token bucket, counted in events: **429 + Retry-After** when exceeded.
3. Admission into a **bounded queue** is all-or-nothing per request: **503 + Retry-After** if the request doesn't fit. Nothing is dropped silently.
4. A **single ordered writer** issues unordered `insertMany` calls of ≤ 1,000 docs. Duplicates are rejected by unique indexes on `_id = eventId` and on `(deviceId, sessionId, seq)`.
5. The HTTP **200 is sent only after the events are durable** (or confirmed duplicates). If the database fails, the response is 503, and the client can retry idempotently.
6. Persisted readings feed the state/alert engine and the broadcaster.

The simulator and load generator share `IngestClient`. It has a bounded outbox, bounded concurrency, and **exponential backoff with jitter** that respects Retry-After. Retries reuse the same eventIds, so they are safe.

## 7. Real-time communication

| Room | Payload | Cadence |
|---|---|---|
| `group:<id>` | `fleet`: only the **changed** device states (versioned) | every 1 s |
| `device:<id>` | `telemetry`: raw readings for that logger | every 250 ms |
| `alerts:<group>` | `incident`: open / update / ack / resolve | immediately |
| `platform` | `platform`: measured server metrics | every 1 s |

- The handshake requires a JWT. `subscribe` is validated (≤ 25 groups/devices), rate-limited, and authorised against the user's groups. The server **joins rooms first and then returns the commit watermark**.
- **History/live handoff:** buffer live → join → fetch history (with watermark) → merge, deduplicated by `eventId` and in a deterministic `(observedAt, deviceId, sessionId, seq, eventId)` order. Events committed after the watermark were broadcast after the join; events at or before it are visible to the query. The union is complete, and the deduplication removes the overlap. Tested in `server/test/realtime.test.ts`.
- **Reconnect:** Socket.IO is not treated as durable. After re-subscribing, the view fetches `/telemetry/:id/since?cursor=<highest seen>` from MongoDB. If the gap exceeds 5,000 events, the UI says **refresh required**.
- **Slow clients:** a socket whose engine.io write buffer exceeds 200 packets is moved to a `lagging` room and excluded from broadcasts. When it drains it gets `resync` and catches up by cursor.
- **Client rendering:** socket messages mutate stores in place. React is notified at most every 250 ms per store, chart buffers are bounded (25k points), the list is virtualised, and filter changes cancel stale requests (AbortController + generation counters).

Details, diagrams, the data model and the trade-offs are in **[ARCHITECTURE.md](ARCHITECTURE.md)**. A short explainer for the team is in [TEAM_NOTES.md](TEAM_NOTES.md).

## 8. Measured performance (summary)

Same laptop for everything (i5-12450H, 12 threads, 16 GB; MongoDB 8 in Docker):

| Offered | Clients | Persisted | Ingest ack p95 | Delivery p95 | Delivery completeness | Server CPU avg |
|---|---|---|---|---|---|---|
| 1,000 ev/s | 20 | 995 ev/s | 42 ms | 252 ms | 100 % (7,500/7,500) | 9 % |
| 4,000 ev/s | 20 | 3,929 ev/s | 95 ms | 254 ms | 100 % | 19 % |
| 15,000 ev/s* | 20 | 14,950 ev/s | 98 ms | 301 ms | 100 % | 33 % |
| 30,000 ev/s* | 20 | **≈14,500 ev/s (saturated)** | 341 ms | 517 ms | 100 % of stored | 64 % |

\* With the per-agent rate limit raised for capacity testing. Delivery latency is dominated by the deliberate 250 ms batching window. Full method, definitions and the observed bottleneck are in [BENCHMARK.md](BENCHMARK.md).

## 9. Repository layout

```
shared/     zod schemas, wire types, ordering + merge logic (ReadingWindow), fleet catalogue
server/     Express + Socket.IO + MongoDB: auth, pipeline, engine (state + alerts), broadcaster, routes
web/        React app: stores, realtime manager, DeviceStream (history/live), pages, uPlot chart
simulator/  seeded device fleet + IngestClient (backoff/jitter), controlled over /agent
loadtest/   rate × clients load generator with delivery-completeness check
e2e/        Playwright demo-flow test + screenshot helpers
```

## 10. Deployment

`Dockerfile` builds a single image that serves the API, Socket.IO and the built SPA. `render.yaml` describes a Render web service (Docker runtime, `/api/healthz` health check) backed by MongoDB Atlas, with `SIM_AUTOSPAWN=true` and `ALLOW_DEMO_RESET=false`. Render is the recommended host for the complete demo because it runs this backend as one persistent process.

### Vercel Services (beta)

The root `vercel.json` configures the `web` Vite frontend and `server` container as services in one Vercel project. The frontend is public on all non-API paths; the backend receives `/api/*` and `/socket.io/*`. Socket.IO is explicitly routed to the same backend service as the API. Browser requests use same-origin paths, so no service binding is needed; MongoDB is an external Atlas connection configured through `MONGO_URL`.

In the Vercel project, configure `MONGO_URL`, `JWT_SECRET` (at least 24 characters), `AGENT_KEY` (`<agent-id>.<secret>` with a secret of at least 16 characters), and `DEMO_PASSWORD`. Set `SIM_AUTOSPAWN=true` only when running a single backend instance; set `ALLOW_DEMO_RESET=false` outside a disposable demo database. The backend adds Vercel's deployment and branch URLs to its CORS allowlist automatically. Add any custom domain to `CORS_ORIGIN` as a comma-separated origin if needed.

Vercel WebSocket support is in beta and connections can close at the function's duration limit, so clients must reconnect. More importantly, ColdGuard's pipeline, alert engine, metrics and simulator are process-local. Multiple backend instances or instance restarts can split in-memory state or start duplicate simulators; this Vercel setup is for evaluation, not a verified horizontally scaled production deployment. Keep the backend to one instance if the Vercel plan/configuration allows it, or use the persistent Render deployment for the complete demo.

## 11. Attribution

External libraries and resources are listed with licences in **[ATTRIBUTION.md](ATTRIBUTION.md)**. The code in this repository was written for this hackathon with AI assistance (Claude), in line with the event's AI usage policy. The team has reviewed it and can explain it.
