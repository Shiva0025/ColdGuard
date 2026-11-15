# Demo script (≈ 5 min)

> **Pitch line:** "A cold-chain dashboard tells you something went wrong. ColdGuard helps you reconstruct the incident, test a response and preserve the evidence — even when connectivity fails."

## Before recording or judging

1. Laptop on the venue Wi-Fi (or your phone hotspot). Run `npm run demo`. Vite prints a `Network:` URL; phones will use it.
2. Sign in as **operator**. Go to Control centre → Reset demo data (type `RESET`). Wait about 60 s so sparklines fill.
3. Control centre → **Judges join by QR** → *Create invite*. If the laptop shows `localhost`, pick the LAN address from the dropdown. Test it with your own phone once.
4. Optional second window: **viewer.western**, to show scoped subscriptions.
5. Have a terminal ready: `npm run loadtest -- --rate 1000 --clients 20 --duration 20 --warmup 5 --recovery 5`
6. Browser zoom 90 %. Close notifications.

## Script

| Time | Screen | Do | Say |
|---|---|---|---|
| 0:00 | Overview | Point at banner, counters, lane board | "ColdGuard watches a simulated fleet of vaccine trucks and cold rooms. Every reading goes through an authenticated, validated ingest API into MongoDB and reaches this screen over Socket.IO." |
| 0:20 | Control centre → QR | Show the QR; judges scan; turn on the *Judges' fleet* corridor chip on the Overview | "Your phones are trucks now. Each runs a small thermal model and streams real telemetry through the same pipeline. Try opening your door." Their trucks appear with their names; opening a door turns the row amber within a second. |
| 0:55 | Control centre | Target **DC-S03**: click **Door left open**, then **Cooling failure** | "On our own truck, the door is left open and the compressor fails." |
| 1:05 | DC-S03 investigation | Open it; point at the door strip, humidity rising, the drift warning (~20–30 s) | "Humidity jumps first, then the temperature climbs. The *drift* alert fires before 8 °C is crossed, with its reasoning in plain language." |
| 1:35 | Break the network panel | **Cut signal** | "Now the truck enters a dead zone. It keeps measuring: watch 'awaiting delivery' count up on the truck. The status ages and goes offline; we never pretend to know the current temperature." |
| 1:50 | Response actions | **Close refrigerated compartment**, **Activate backup cooling** | "The operator responds anyway. Both commands are *requested* and *delivered*, but marked *queued — truck offline*. Nothing is claimed until the truck applies it and the data proves it." |
| 2:10 | Break the network | **Restore signal** | "Signal back. The buffered readings arrive as a burst and are slotted into history by observed time; the catch-up bar fills, and duplicates and chart duplicates are zero. The excursion alert is raised from the backfilled data itself." |
| 2:30 | Response actions | Watch the lifecycle reach **Applied → Confirmed** | "Confirmed means telemetry shows it: door sensor closed, backup cooling running, temperature falling. The dashed line is the same simulation cloned at that moment without our action. It's a simulated comparison, not a forecast, but it shows what the response bought: minutes out of range and heat budget." |
| 3:00 | Incident card → **Acknowledge**, then **Replay incident** | Press Play at 60× | "Replay reconstructs how this happened: door opened, humidity rose, temperature began climbing, signal lost, commands queued, backfill, recovery. The truck moves along its route. 'Possible contributing factors' lists the door and the compressor with evidence and timing, and says plainly that correlation isn't proof." |
| 3:40 | Investigation → Evidence chain | **Verify now** (green) → **Tamper with a stored reading** → red | "Every reading is sealed into hash-linked blocks. Here an insider edits MongoDB directly to hide the peak. Verification points to the exact block and event id. Undo, and it's intact again." |
| 4:05 | Incident → **Evidence report** | Show the page; download the JSON; in the terminal run `npm run verify-report -- <file>` | "The report verifies offline from the file alone. Change one number and it fails." |
| 4:25 | Terminal + Platform page | Run the load test | "And it holds up: 1,000 events a second with 20 clients at about 9 % CPU and 100 % delivery completeness, measured on this laptop. The single writer saturates at about 14,500 ev/s, and it's all in BENCHMARK.md." |
| 4:50 | Overview | — | "Monitor, respond, reconstruct, prove. That's ColdGuard." |

## Timings to know

- Door + compressor failure: drift alert ≈ 20–30 s, sustained excursion ≈ 60–75 s (20 s sustain).
- Backup cooling with the door closed recovers ≈ 1 °C/min; the incident resolves 20 s after re-entering 2–7.5 °C.
- If you are short on time: Control centre → Alert rules → *Sustained for* `10`.

## Backup plans

- **Phones can't reach the laptop** (client isolation on venue Wi-Fi): press *Open public link* in the Judges panel — the QR code switches to a public tunnel URL (needs `cloudflared` or a configured `ngrok` on the laptop, and internet). Fallback: a phone hotspot, or show the phone flow from a second browser window at mobile size (`/join/<code>`).
- **Simulator not connected:** `npm run dev -w simulator`.
- **A judge leaves their door open:** that's part of the demo. Their truck gets its own explained alert, and you can send them a *Close compartment* command they'll see on their phone.
