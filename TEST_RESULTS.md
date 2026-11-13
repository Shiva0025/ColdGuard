# Test results

> **Update (signature features):** the suite now has **54 automated tests (7 unit + 47 integration)**, all passing. See §7 for the new tests, the scripted browser checks, and the bugs they caught.

Recorded on 2026-11-13 on the benchmark laptop (Node 22.22.1, MongoDB 8.0.38 in Docker on :27027, Chrome for Playwright). Every result below was observed in this session.

## 1. Type checking: all five workspaces

```
$ npm run typecheck
… shared ✓  server ✓  web ✓  simulator ✓  loadtest ✓   (exit 0)
```

## 2. Unit + integration tests: `npm test`

The integration tests start the **real server in-process** against a **real MongoDB** (a fresh database per suite, dropped afterwards) and connect **real Socket.IO clients**. Nothing is mocked.

```
$ npm test

```
✓ test/merge.test.ts (7 tests) 12ms
Tests  7 passed (7)
Duration  1.14s (transform 109ms, setup 0ms, collect 82ms, tests 12ms, environment 0ms, prepare 133ms)
✓ test/ingest.test.ts > authentication & authorisation (REST) > rejects bad credentials and unauthenticated requests 114ms
✓ test/ingest.test.ts > authentication & authorisation (REST) > scopes data to the user’s groups 83ms
✓ test/ingest.test.ts > authentication & authorisation (REST) > enforces operator-only actions 150ms
✓ test/ingest.test.ts > authentication & authorisation (REST) > rejects ingestion without a valid agent credential 6ms
✓ test/ingest.test.ts > ingestion validation, idempotency and ordering > validates batch shape, size and payload 23ms
✓ test/ingest.test.ts > ingestion validation, idempotency and ordering > rejects individual invalid events but persists the valid ones 10ms
✓ test/ingest.test.ts > ingestion validation, idempotency and ordering > is idempotent: re-sending the same events stores them once 38ms
✓ test/ingest.test.ts > ingestion validation, idempotency and ordering > treats a re-minted eventId at the same (device, session, seq) as a duplicate 11ms
✓ test/ingest.test.ts > ingestion validation, idempotency and ordering > stores out-of-order readings as late without moving current state backwards 159ms
✓ test/ingest.test.ts > ingestion validation, idempotency and ordering > accepts a new source session (device restart) only when it is newer in time 17ms
✓ test/ingest.test.ts > overload, rate limiting and client retry > returns 503 + Retry-After when a batch does not fit the bounded queue, and stores nothing from it 15ms
✓ test/ingest.test.ts > overload, rate limiting and client retry > returns 429 when the per-agent event rate is exceeded 60ms
✓ test/ingest.test.ts > overload, rate limiting and client retry > simulator client backs off, retries idempotently and eventually delivers everything exactly once 7995ms
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > does not alert on a brief (unsustained) breach 32ms
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > opens one explained incident for a sustained breach and deduplicates further breaches 70ms
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > the partial unique index rejects a second active incident at the database boundary 7ms
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > only operators can acknowledge; ack records user and time 270ms
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > recovers only after staying inside the hysteresis band for the recovery time (no flicker) 30ms
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > a late (out-of-order) reading never re-opens or resets alert state 18ms
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > raises an early drift warning before the threshold is crossed 14ms
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > detects sensor-offline from the server clock and resolves when data resumes 6521ms
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > opens and clears a low battery warning with hysteresis 23ms
✓ test/realtime.test.ts > Socket.IO authentication, rooms and independent subscriptions > refuses connections without a valid token 36ms
✓ test/realtime.test.ts > Socket.IO authentication, rooms and independent subscriptions > refuses room joins outside the user’s groups and validates payloads 209ms
✓ test/realtime.test.ts > Socket.IO authentication, rooms and independent subscriptions > delivers only relevant updates to each client 467ms
✓ test/realtime.test.ts > Socket.IO authentication, rooms and independent subscriptions > stops delivery after a subscription is replaced (no stale leak) 248ms
✓ test/realtime.test.ts > history + live consistency > loses nothing and duplicates nothing when events arrive while history loads 458ms
✓ test/realtime.test.ts > history + live consistency > catches up from MongoDB after a disconnect using the cursor 192ms
✓ test/realtime.test.ts > history + live consistency > serves aggregated buckets plus a raw tail for long ranges with a defined boundary 546ms
Tests  29 passed (29)
Duration  26.56s (transform 340ms, setup 0ms, collect 2.42s, tests 22.58s, environment 1ms, prepare 365ms)
```

(One early run failed at configuration validation, `FLEET_EMIT_MS` min 100, because the tests use a 50 ms flush. The minimum was lowered to 20 ms, and the alert tests' regex was updated after explanations switched to 2-decimal first-breach values. The output above is the final run.)

### Coverage map

| Requirement | Test(s) |
|---|---|
| Validation | `validates batch shape, size and payload`; `rejects individual invalid events but persists the valid ones` (range, unknown device, future/late timestamp, unknown field); 413 on oversized body |
| Authentication | `rejects bad credentials…`; `rejects ingestion without a valid agent credential`; `refuses connections without a valid token` |
| Authorisation | `scopes data to the user's groups`; `enforces operator-only actions`; `refuses room joins outside the user's groups`; `only operators can acknowledge` |
| Independent subscriptions | `delivers only relevant updates to each client` (two users, two corridors, telemetry + fleet deltas); `stops delivery after a subscription is replaced` |
| Idempotent duplicates | `is idempotent…` (across requests and inside one batch); `treats a re-minted eventId at the same (device, session, seq) as a duplicate` |
| Out-of-order / sessions | `stores out-of-order readings as late without moving current state backwards`; `accepts a new source session … only when it is newer in time`; `a late reading never re-opens or resets alert state` |
| History/live overlap | `loses nothing and duplicates nothing when events arrive while history loads` (continuous writer during handoff; merged set equals MongoDB exactly); shared `mergeHistoryAndLive` unit test |
| Raw vs aggregated | `serves aggregated buckets plus a raw tail … with a defined boundary` (5,200 readings: buckets + tail partition exactly) |
| Reconnect catch-up | `catches up from MongoDB after a disconnect using the cursor` |
| Alerts | `does not alert on a brief breach`; `opens one explained incident … and deduplicates`; `partial unique index rejects a second active incident`; `recovers only after … hysteresis band … (no flicker)`; `raises an early drift warning before the threshold is crossed`; `detects sensor-offline … and resolves`; `low battery … with hysteresis` |
| Queue bounds / overload / retry | `returns 503 + Retry-After when a batch does not fit the bounded queue, and stores nothing from it`; `returns 429 when the per-agent event rate is exceeded`; `simulator client backs off, retries idempotently and eventually delivers everything exactly once` (1,200 events through a throttled server, 0 extra rows) |

## 3. End-to-end browser test: `npx playwright test`

Run against the live dev stack (`npm run dev`) in system Chrome:

```
$ npx playwright test
Running 1 test using 1 worker
  ✓  1 e2e/demo.spec.ts:20:5 › cold-chain incident: two users, live alert, acknowledgement, reconnect catch-up (1.4m)
  1 passed (1.4m)
```

The test signs in as `operator` and `viewer.western` in separate browser contexts and checks that the viewer sees no Deccan loggers. It then injects a cooling failure on DC-S07 from the Control centre and waits for the **drift warning** and then the **critical excursion**, both pushed live, and checks the explanation text. It confirms the Western viewer never receives the incident, acknowledges it with a note, drag-zooms the chart (**Paused**), clicks **Resume live** (**Live**), clicks **Drop connection** (**Reconnecting** → **Live**, catch-up counter > 0), restores the device, and finally asserts there were no page errors in either tab.

## 4. Manual UI inspection

Screenshots taken with `e2e/screenshot.mjs` (headless Chrome) at **1440×900** and **390×844**, for the overview, investigation, control centre and platform pages:

- No console or page errors on any page.
- Found and fixed during inspection:
  - false drift alerts caused by too-strong simulated compressor cycling;
  - custom CSS overriding Tailwind utilities (moved into `@layer components`);
  - "0.0 ms" displayed when no latency samples existed (now `—`);
  - the investigation chart auto-pausing on load (uPlot commits scales asynchronously, so a user zoom is now detected from the pointer gesture);
  - clipped threshold labels (inherited canvas `textAlign`);
  - an empty humidity/battery chart;
  - UTC times in incident explanations (now `DISPLAY_TZ`);
  - horizontal overflow of the filter bar at 390 px.
- `e2e/zoom-check.mjs` confirms drag-zoom → "Paused · data still merging" → Resume live → "Live".

## 5. Production image

```
$ docker build -t coldguard:local .            # success, 606 MB
$ docker run --network host -e PORT=4100   # image sets NODE_ENV=production -e MONGO_URL=… -e JWT_SECRET=<random> \
    -e AGENT_KEY=sim-agent.<random> -e DEMO_PASSWORD=… -e SIM_AUTOSPAWN=true coldguard:local
GET /api/healthz          → {"ok":true,"queueDepth":0}
GET /                     → built SPA (<title>ColdGuard · cold-chain operations)
login + GET /api/metrics  → persisted/s 24, simulator {connected:true, running:true}
logs: "[boot] empty database seeded…", "[sim] connected to http://127.0.0.1:4100/agent"
```

## 6. Not verified

- Behaviour on a real hosting provider (Render/Railway): not deployed in this session.
- Browser frame-timing under the 1,000 ev/s load (load clients are Node Socket.IO clients).
- Screen-reader walkthrough: semantic roles, labels, focus rings and keyboard-reachable controls were implemented, but no assistive-technology audit was run.
- Long-duration soak (> 5 minutes at high rate) and TTL expiry in practice (TTL index creation is verified at startup).

## 7. Signature features: tests and live checks (2026-11-13, afternoon)

```
$ npm run typecheck   # exit 0
$ npm test
 shared: 7 passed
 server: Test Files 7 passed (7) · Tests 47 passed (47)
```

<details><summary>Full server test list</summary>

```
✓ test/merge.test.ts (7 tests)
✓ test/ingest.test.ts > authentication & authorisation (REST) > rejects bad credentials and unauthenticated requests
✓ test/ingest.test.ts > authentication & authorisation (REST) > scopes data to the user’s groups
✓ test/ingest.test.ts > authentication & authorisation (REST) > enforces operator-only actions
✓ test/ingest.test.ts > authentication & authorisation (REST) > rejects ingestion without a valid agent credential
✓ test/ingest.test.ts > ingestion validation, idempotency and ordering > validates batch shape, size and payload
✓ test/ingest.test.ts > ingestion validation, idempotency and ordering > rejects individual invalid events but persists the valid ones
✓ test/ingest.test.ts > ingestion validation, idempotency and ordering > is idempotent: re-sending the same events stores them once
✓ test/ingest.test.ts > ingestion validation, idempotency and ordering > treats a re-minted eventId at the same (device, session, seq) as a duplicate
✓ test/ingest.test.ts > ingestion validation, idempotency and ordering > stores out-of-order readings as late without moving current state backwards
✓ test/ingest.test.ts > ingestion validation, idempotency and ordering > accepts a new source session (device restart) only when it is newer in time
✓ test/ingest.test.ts > overload, rate limiting and client retry > returns 503 + Retry-After when a batch does not fit the bounded queue, and stores nothing from it
✓ test/ingest.test.ts > overload, rate limiting and client retry > returns 429 when the per-agent event rate is exceeded
✓ test/ingest.test.ts > overload, rate limiting and client retry > simulator client backs off, retries idempotently and eventually delivers everything exactly once
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > does not alert on a brief (unsustained) breach
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > opens one explained incident for a sustained breach and deduplicates further breaches
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > the partial unique index rejects a second active incident at the database boundary
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > only operators can acknowledge; ack records user and time
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > recovers only after staying inside the hysteresis band for the recovery time (no flicker)
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > a late (out-of-order) reading never re-opens or resets alert state
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > raises an early drift warning before the threshold is crossed
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > detects sensor-offline from the server clock and resolves when data resumes
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > opens and clears a low battery warning with hysteresis
✓ test/alerts.test.ts > incident detection, dedupe, acknowledgement and recovery > integrates heat exposure and raises a budget incident; recovery does not refund the budget
✓ test/evidence.test.ts > tamper-evident evidence chain > verifies an untouched chain
✓ test/evidence.test.ts > tamper-evident evidence chain > pinpoints a silently altered reading and recovers after undo
✓ test/evidence.test.ts > tamper-evident evidence chain > detects deleted and inserted readings
✓ test/evidence.test.ts > tamper-evident evidence chain > exports a report that verifies offline — and fails offline once edited
✓ test/evidence.test.ts > tamper-evident evidence chain > stays verifiable when the demo is reset while readings are streaming
✓ test/realtime.test.ts > Socket.IO authentication, rooms and independent subscriptions > refuses connections without a valid token
✓ test/realtime.test.ts > Socket.IO authentication, rooms and independent subscriptions > refuses room joins outside the user’s groups and validates payloads
✓ test/realtime.test.ts > Socket.IO authentication, rooms and independent subscriptions > delivers only relevant updates to each client
✓ test/realtime.test.ts > Socket.IO authentication, rooms and independent subscriptions > stops delivery after a subscription is replaced (no stale leak)
✓ test/realtime.test.ts > history + live consistency > loses nothing and duplicates nothing when events arrive while history loads
✓ test/realtime.test.ts > history + live consistency > catches up from MongoDB after a disconnect using the cursor
✓ test/realtime.test.ts > history + live consistency > serves aggregated buckets plus a raw tail for long ranges with a defined boundary
✓ test/guest.test.ts > judges join by QR: phone trucks > only operators can create invites; a bad code is refused
✓ test/guest.test.ts > judges join by QR: phone trucks > assigns distinct trucks and scopes each phone to its own truck
✓ test/guest.test.ts > judges join by QR: phone trucks > routes operator commands for a phone truck to that phone and completes the lifecycle
✓ test/guest.test.ts > judges join by QR: phone trucks > release frees the trucks and invalidates the invite
✓ test/commands.test.ts > operator commands: requested → delivered → acknowledged → effect observed > only operators may issue commands, and payloads are validated
✓ test/commands.test.ts > operator commands: requested → delivered → acknowledged → effect observed > confirms the effect only from telemetry, not from the simulator’s word
✓ test/commands.test.ts > operator commands: requested → delivered → acknowledged → effect observed > shows a command as queued while the truck is offline and completes it after reconnect
✓ test/commands.test.ts > operator commands: requested → delivered → acknowledged → effect observed > records the action on the linked incident timeline
✓ test/replay.test.ts > incident replay story > orders derived events and finds onset, door and breach
✓ test/replay.test.ts > incident replay story > names the door as a POSSIBLE factor with evidence and a causation caveat
✓ test/replay.test.ts > incident replay story > reports buffered readings that were delivered late
✓ test/replay.test.ts > incident replay story > does not invent a factor when nothing was recorded
```
</details>

New integration suites (real MongoDB + Socket.IO; a real `/agent` socket or driver socket plays the truck):

| Suite | Proves |
|---|---|
| `commands.test.ts` | operator-only, validated commands; full lifecycle; **effect confirmed only by telemetry** (a non-confirming reading leaves it "acknowledged"); queued while offline then completed; action written to the incident timeline |
| `replay.test.ts` | ordered story; onset within 15 s of the true climb on a noisy plateau; door named as a *possible* factor with duration evidence and a causation caveat; backfill detected; no invented factor when nothing was recorded |
| `guest.test.ts` | invite is operator-only; bad code and bad name are refused; distinct trucks; phone token can ingest/read/subscribe only its own truck and cannot command; commands routed to the phone complete the lifecycle; release invalidates the invite |
| `alerts.test.ts › heat exposure` | trapezoid integral to 2 decimal places; gaps not integrated; budget incident; recovery does not refund |
| `evidence.test.ts` | intact chain; altered reading pinpointed by event id and recovered by undo; deleted and inserted readings detected; the exported report verifies with the CLI and fails after a one-value edit; **chain stays valid when the demo is reset mid-stream** |

Browser checks against the running stack (headless Chrome, scripts in `e2e/`):

```
$ npx playwright test                                   # original demo flow, now self-resetting
  ✓ cold-chain incident: two users, live alert, acknowledgement, reconnect catch-up (1.9m)

$ node e2e/network-check.mjs out DC-S05                 # break the network
offline panel:   Truck offline · buffering | Awaiting delivery 21 (21 on truck) | Commands waiting for signal 1 | Latest reading age 23 s
after reconnect: Reconnect catch-up 23 / 23 buffered readings stored | Duplicates rejected 0 | Awaiting delivery 0 | Chart points / duplicates 855 / 0 | stream: Live

$ node e2e/judge-check.mjs out                          # operator + phone (Pixel 7 profile)
phone drives GT-01 · command lifecycle: requested → delivered → acknowledged → effect_observed | queuedOffline true
phone: STORED ON SERVER 22 · WAITING 0 · DURABLE ACK 30 ms · errors []

$ node e2e/evidence-check.mjs out DC-S04 <incident>     # tamper-evidence
before: Intact — every stored reading matches its seal
after tamper: Chain broken at block #11: reading altered | stored values of DC-S04:…:589 (now 9.7 °C) do not match what was sealed
report while tampered: Evidence FAILED verification at block #11: reading altered
after undo: Intact

$ npm run verify-report -- report.json                  # offline, from a live incident report
Blocks 0…8 · 97 readings checked
VERIFIED ✓  chain head 48510854370a6a3a…
```

**Defects found and fixed while building these features:**
- Command "applied" could overtake the delivery ack, skipping "delivered" in the timeline (caught by a test).
- Replay onset first latched onto normal thermostat cycling, then onto the earliest dip of a noisy plateau (caught by live data and then a unit test). It now uses a centred average and the last floor point.
- Exposure rounding drift of about 0.07 °C·min per 200 readings (caught by a test).
- **Demo reset raced with in-flight evidence sealing**, so the new chain continued from a deleted block and reported a false break (caught live; fixed by serialising reset with the sealer; regression test added).
- Restore boost of 180 s was too short to bring a truck back from about 20 °C (caught by the E2E run).
- Door factor skipped for a 58 s opening (threshold lowered to 30 s).

Not verified: real phones on a venue network (only the Pixel 7 emulation in headless Chrome); printing to paper (print CSS checked on screen only).
