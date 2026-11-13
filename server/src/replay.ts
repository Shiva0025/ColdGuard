import { COMMAND_LABEL, INCIDENT_LABEL, type Command, type Incident, type Reading, type Rules } from '@coldguard/shared';

export type StoryKind =
  | 'door_open'
  | 'door_closed'
  | 'cooling_fault'
  | 'backup_on'
  | 'cooling_restored'
  | 'humidity_rise'
  | 'temp_climb'
  | 'first_breach'
  | 'peak'
  | 'back_in_range'
  | 'incident'
  | 'ack'
  | 'resolved'
  | 'command'
  | 'offline'
  | 'backfill';

export interface StoryEvent {
  t: number;
  kind: StoryKind;
  title: string;
  detail?: string;
  severity: 'info' | 'warning' | 'critical' | 'ok';
  eventId?: string;
}

export interface Factor {
  title: string;
  relation: string;
  evidence: string[];
  caveat: string;
}

const near = (ms: number) => (Math.abs(ms) < 1000 ? 'at the same moment' : `within ${fmtDur(Math.abs(ms))} of the moment`);
const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};

/**
 * Reconstruct "how this happened" from persisted telemetry. Everything is a
 * deterministic rule over stored readings, incidents and commands — no model,
 * no hidden score. Contributing factors are phrased as *possible*, list their
 * evidence, and carry an explicit caveat that correlation is not causation.
 */
export function buildStory(input: {
  readings: Reading[]; // sorted by observedAt
  incident: Incident;
  related: Incident[];
  commands: Command[];
  rules: Rules;
  tz?: string;
}): { events: StoryEvent[]; factors: Factor[]; onsetAt: number | null; firstBreachAt: number | null } {
  const { readings: rs, incident, related, commands, rules } = input;
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: input.tz ?? 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const T = (ms: number) => fmt.format(ms);
  const events: StoryEvent[] = [];
  const doorSpans: { from: number; to: number; humFrom: number; humMax: number }[] = [];
  let faultFrom: number | null = null;
  let faultCount = 0;

  // Door + cooling transitions.
  let prev: Reading | undefined;
  let openSpan: { from: number; humFrom: number; humMax: number } | null = null;
  for (const r of rs) {
    if (prev) {
      if (r.door === 1 && prev.door !== 1) {
        openSpan = { from: r.t, humFrom: prev.h, humMax: r.h };
        events.push({ t: r.t, kind: 'door_open', title: 'Compartment door opened', severity: 'warning', eventId: r.id });
      }
      if (r.door !== 1 && prev.door === 1 && openSpan) {
        doorSpans.push({ ...openSpan, to: r.t });
        events.push({ t: r.t, kind: 'door_closed', title: 'Door closed', detail: `open for ${fmtDur(r.t - openSpan.from)}`, severity: 'ok', eventId: r.id });
        openSpan = null;
      }
      if (r.cs === 2 && prev.cs !== 2) {
        faultFrom ??= r.t;
        events.push({ t: r.t, kind: 'cooling_fault', title: 'Compressor reports FAULT', severity: 'critical', eventId: r.id });
      }
      if (r.cs === 3 && prev.cs !== 3) events.push({ t: r.t, kind: 'backup_on', title: 'Backup cooling running', severity: 'info', eventId: r.id });
      if ((r.cs === 0 || r.cs === 1) && (prev.cs === 2 || prev.cs === 3))
        events.push({ t: r.t, kind: 'cooling_restored', title: 'Primary cooling running again', severity: 'ok', eventId: r.id });
    } else if (r.door === 1) {
      openSpan = { from: r.t, humFrom: r.h, humMax: r.h };
    }
    if (openSpan) openSpan.humMax = Math.max(openSpan.humMax, r.h);
    if (r.cs === 2) faultCount++;
    prev = r;
  }
  if (openSpan && prev) doorSpans.push({ ...openSpan, to: prev.t });
  if (rs[0]?.cs === 2) faultFrom ??= rs[0].t;

  // Humidity rise: +8 %RH over the median of the first two minutes.
  if (rs.length > 10) {
    const base = rs.filter((r) => r.t <= rs[0].t + 120_000).map((r) => r.h).sort((a, b) => a - b);
    const med = base[Math.floor(base.length / 2)];
    const hr = rs.find((r) => r.h >= med + 8);
    if (hr) events.push({ t: hr.t, kind: 'humidity_rise', title: 'Humidity rising', detail: `${med.toFixed(0)} → ${hr.h.toFixed(0)} %RH`, severity: 'warning', eventId: hr.id });
  }

  const high = incident.type === 'temp_low' ? null : rules.tempHighC;
  const breach = rs.find((r) => (high != null ? r.tc > high : r.tc < rules.tempLowC));
  const firstBreachAt = breach?.t ?? null;

  // Temperature onset = the start of the climb that led to the breach (or alert):
  // walk back from the anchor along a centred 5-reading moving average while it stays within
  // 0.1 °C of the running minimum; the onset is the last point still at that floor. Earlier thermostat cycles are therefore not mistaken for it.
  let onsetAt: number | null = null;
  const anchorT = firstBreachAt ?? incident.triggeredAt;
  const pre = rs.filter((r) => r.t >= anchorT - 10 * 60_000 && r.t <= anchorT);
  if (pre.length >= 5 && incident.type !== 'temp_low') {
    const avg = pre.map((r, i) => {
      const w = pre.slice(Math.max(0, i - 2), i + 3); // centred: no lag
      return w.reduce((a, b) => a + b.tc, 0) / w.length;
    });
    // Walk backwards from the anchor while the smoothed temperature stays within 0.1 °C of
    // the lowest value seen so far; the onset is that minimum (the bottom of the final climb).
    let k = avg.length - 1;
    let j = k;
    while (j > 0 && avg[j - 1] <= avg[k] + 0.1) {
      j--;
      if (avg[j] < avg[k]) k = j;
    }
    // On a flat, noisy floor take the LAST point still at floor level: that is where the climb starts.
    const floor = avg[k];
    for (let i = k; i < avg.length; i++) if (avg[i] <= floor + 0.1) k = i;
    const o = pre[k];
    const end = pre[pre.length - 1];
    const rate = (end.tc - o.tc) / Math.max(1, (end.t - o.t) / 60_000);
    if (end.t - o.t >= 20_000 && rate > 0.5) {
      onsetAt = o.t;
      events.push({
        t: o.t,
        kind: 'temp_climb',
        title: 'Temperature began climbing',
        detail: `${o.tc.toFixed(1)} → ${end.tc.toFixed(1)} °C in ${fmtDur(end.t - o.t)} (≈${rate.toFixed(1)} °C/min)`,
        severity: 'warning',
        eventId: o.id,
      });
    }
  }
  if (breach)
    events.push({
      t: breach.t,
      kind: 'first_breach',
      title: `First reading outside ${rules.tempLowC}–${rules.tempHighC} °C`,
      detail: `${breach.tc.toFixed(2)} °C`,
      severity: 'critical',
      eventId: breach.id,
    });
  if (rs.length) {
    const peak = rs.reduce((a, b) => (b.tc > a.tc ? b : a));
    if (breach) events.push({ t: peak.t, kind: 'peak', title: 'Peak temperature', detail: `${peak.tc.toFixed(2)} °C`, severity: 'critical', eventId: peak.id });
    const back = breach ? rs.find((r) => r.t > peak.t && r.tc <= rules.tempHighC && r.tc >= rules.tempLowC) : undefined;
    if (back) events.push({ t: back.t, kind: 'back_in_range', title: 'Back inside the range', detail: `${back.tc.toFixed(2)} °C`, severity: 'ok', eventId: back.id });
  }

  // Store-and-forward: readings delivered ≥ 10 s after they were observed.
  const late = rs.filter((r) => r.r - r.t >= 10_000);
  if (late.length) {
    const first = late[0];
    const deliveredAt = Math.max(...late.map((r) => r.r));
    events.push({
      t: first.t,
      kind: 'backfill',
      title: 'Truck lost connectivity — readings buffered on the device',
      detail: `${late.length} readings observed from ${T(first.t)} were delivered at ${T(deliveredAt)} and slotted into history by observed time`,
      severity: 'warning',
    });
  }

  for (const i of [incident, ...related]) {
    events.push({
      t: i.triggeredAt,
      kind: i.type === 'sensor_offline' ? 'offline' : 'incident',
      title: `${INCIDENT_LABEL[i.type]} alert`,
      detail: i.explanation,
      severity: i.severity,
    });
    if (i.ack) events.push({ t: i.ack.at, kind: 'ack', title: `Acknowledged by ${i.ack.by}`, detail: i.ack.note, severity: 'info' });
    if (i.resolvedAt) events.push({ t: i.resolvedAt, kind: 'resolved', title: `${INCIDENT_LABEL[i.type]} resolved`, detail: i.timeline.find((e) => e.kind === 'resolved')?.text, severity: 'ok' });
  }
  for (const c of commands) {
    events.push({ t: c.requestedAt, kind: 'command', title: `${COMMAND_LABEL[c.kind]} requested`, detail: `by ${c.requestedBy}${c.queuedOffline ? ' · queued while truck offline' : ''}`, severity: 'info' });
    if (c.acknowledgedAt) events.push({ t: c.acknowledgedAt, kind: 'command', title: `Truck applied: ${COMMAND_LABEL[c.kind].toLowerCase()}`, severity: 'info' });
    if (c.effect) events.push({ t: c.effect.t, kind: 'command', title: 'Effect confirmed in telemetry', detail: c.effect.text, severity: 'ok', eventId: c.effect.eventId });
  }
  events.sort((a, b) => a.t - b.t);

  // ---- Possible contributing factors (evidence-backed, never asserted as cause) ----
  const factors: Factor[] = [];
  const caveat = 'Based on the order of recorded events. Telemetry shows these happened together; it cannot prove cause.';
  const anchor = onsetAt ?? firstBreachAt;
  const climbEnd = firstBreachAt ?? incident.triggeredAt;
  for (const d of doorSpans) {
    const dur = d.to - d.from;
    if (dur < 30_000 || anchor == null) continue;
    // Door open at some point between 15 min before the onset and the first breach.
    if (d.from > climbEnd || d.to < anchor - 15 * 60_000) continue;
    const lead = anchor - d.from;
    factors.push({
      title: dur >= 180_000 ? 'Possible contributing factor: prolonged door opening' : 'Possible contributing factor: door opening',
      relation:
        Math.abs(lead) <= 30_000
          ? `Door opened ${near(lead)} the temperature began climbing, ${fmtDur(climbEnd - d.from)} before the range was exceeded.`
          : lead >= 0
          ? `Door opened ${fmtDur(lead)} before the temperature ${onsetAt ? 'began climbing' : 'first left the range'}.`
          : `Door opened ${fmtDur(-lead)} after the temperature began climbing, ${fmtDur(climbEnd - d.from)} before the range was exceeded.`,
      evidence: [
        `Door sensor open from ${T(d.from)} to ${T(d.to)} (${fmtDur(dur)}).`,
        `Humidity rose ${d.humFrom.toFixed(0)} → ${d.humMax.toFixed(0)} %RH while the door was open.`,
      ],
      caveat,
    });
  }
  if (faultFrom != null && anchor != null && faultFrom <= climbEnd) {
    factors.push({
      title: 'Possible contributing factor: primary cooling fault',
      relation:
        Math.abs(anchor - faultFrom) <= 30_000
          ? `Compressor reported FAULT ${near(anchor - faultFrom)} the temperature began climbing, ${fmtDur(climbEnd - faultFrom)} before the range was exceeded.`
          : faultFrom <= anchor
          ? `Compressor reported FAULT ${fmtDur(anchor - faultFrom)} before the temperature ${onsetAt ? 'began climbing' : 'left the range'}.`
          : `Compressor reported FAULT ${fmtDur(faultFrom - anchor)} after the rise began, ${fmtDur(climbEnd - faultFrom)} before the range was exceeded.`,
      evidence: [`Cooling state "fault" first reported at ${T(faultFrom)}; ${faultCount} readings in this window report it.`],
      caveat,
    });
  }
  if (!factors.length && anchor != null) {
    factors.push({
      title: 'No recorded door or cooling event explains the rise',
      relation: 'The door stayed closed and the cooling unit reported normal operation around the onset.',
      evidence: ['Consider ambient exposure, sensor placement, or an unmonitored load change.'],
      caveat,
    });
  }
  return { events, factors, onsetAt, firstBreachAt };
}
