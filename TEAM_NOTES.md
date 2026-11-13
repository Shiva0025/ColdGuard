# How ColdGuard works (team cheat-sheet)

**Batching.** The simulator sends HTTP batches of up to 250 readings. The server's single writer coalesces queued readings into `insertMany` calls of up to 1,000 (15 ms linger). The broadcaster buffers readings per device room and emits every 250 ms; fleet rooms get one message per second containing only the devices that changed. In the browser, socket messages update plain objects, and React is told about it at most 4 times a second. *Code:* `server/src/pipeline.ts`, `server/src/broadcaster.ts`, `web/src/lib/stores.ts`.

**Rooms.** `group:deccan` and `group:western` carry fleet deltas. `device:DC-S03` carries raw readings while someone is investigating that logger. `alerts:<group>` carries incidents, and `platform` carries measured metrics. A browser asks to `subscribe`; the server checks the JWT's groups before joining any room. A Deccan viewer therefore can't receive Western data even with a modified client. *Code:* `server/src/socket.ts`.

**Deduplication.** Each reading's `eventId` is MongoDB's `_id`, and `(device, session, seq)` is also unique, so storing the same reading twice is impossible. That makes retries safe. Incidents are deduplicated by a partial unique index (one *active* incident per logger and rule). In the browser, `ReadingWindow` ignores an eventId it already holds. That matters because history and live data overlap by design. *Code:* `server/src/db.ts`, `shared/src/merge.ts`.

**Back-pressure.** A per-agent token bucket returns 429 above 5,000 ev/s, and a bounded queue returns 503 when a batch won't fit. Both send `Retry-After`. We never enqueue half a request and never answer 200 before the write is durable. The simulator backs off exponentially with jitter and resends the same events. Slow browsers are parked in a `lagging` room and told to `resync` once they drain. *Code:* `server/src/routes.ts`, `simulator/src/client.ts`.

**Reconnection.** We don't trust Socket.IO to be durable. Every persisted reading gets a server cursor `c`. On (re)subscribe the server joins rooms *first* and then returns the current watermark. The view loads history (everything ≤ watermark is in it) and merges it with what arrived live (everything after). After a disconnect the view asks `/since?cursor=<last seen>`, and if the gap is too big it says "refresh required" rather than showing partial data. Late readings are stored and shown, but never move a logger's current state backwards. *Code:* `web/src/lib/deviceStream.ts`, `web/src/lib/realtime.ts`.

**Rescue commands.** Operator → server (`commands` collection) → Socket.IO to the simulator, or to the judge's phone for GT trucks. The truck acks "delivered" (or "queued — offline") and later "applied", sending a cloned-model projection without the command. The server marks "confirmed" only when a persisted reading proves it. *Code:* `server/src/commands.ts`, `simulator/src/index.ts`, `web/src/components/ResponsePanel.tsx`.

**Replay.** `server/src/replay.ts` turns stored readings, incidents and commands into a story with deterministic rules. Factors are "possible", carry evidence, and carry a causation caveat. *UI:* `web/src/pages/Replay.tsx`.

**Break the network.** Simulator uplink faults per truck: store-and-forward buffer, delayed or reordered sends, duplicates. The panel shows MongoDB counts, pipeline counters, uplink status and this tab's buffer. *Code:* `web/src/components/NetworkPanel.tsx`, `GET /devices/:id/integrity`.

**Judges' phones.** Invite code → `/guest/claim` → driver JWT for one `GT-xx` truck. The phone runs the shared `ThermalModel`, posts batches with `Bearer`, and answers commands. *Code:* `web/src/phone/PhoneApp.tsx`, `routes.ts` (guest), `auth.ts` (driver).

**Heat budget.** Trapezoid integral of degrees outside the band, over in-order readings, with no integration across gaps > 60 s. It is a demo calculation and does not refund on recovery. *Code:* `engine.ts › evalExposure`.

**Evidence chain.** Per-truck SHA-256 blocks of ≤ 60 readings, in commit order, linked by hash. `verify` names the first altered, missing or extra reading. Reports verify offline (`npm run verify-report`). It cannot prove the sensor told the truth, or stop someone who controls the server from re-sealing. *Code:* `server/src/evidence.ts`.

**Likely judge questions**
- *Is the "without intervention" line a prediction?* No. It is the same simulated model cloned at that instant and run forward without the command, labelled as a simulated comparison.
- *Does the replay claim the door caused it?* No. It reports timing and evidence and says correlation isn't causation; if nothing fits, it says nothing explains it.
- *What stops a phone from sending data for another truck?* Its token names one device; the server rejects readings for any other device, scopes reads and rooms, and rate-limits it separately.
- *Why not a time-series collection?* They don't support unique indexes, and our idempotency depends on one.
- *What's the limit?* About 14.5k ev/s durable on one laptop. The single ordered writer is the bottleneck; the fix is pipelined writers with a contiguous-cursor watermark.
- *Is the latency real?* It's measured from server `receivedAt` to client receipt on one machine (same clock). In the browser we correct with an NTP-style clock-offset estimate and show ±RTT/2. Most of it is the deliberate 250 ms batching window.
