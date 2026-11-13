import {
  excessDegMin,
  COOLING_FROM_CODE,
  DEFAULT_RULES,
  isNewerThan,
  type DeviceInfo,
  type DeviceState,
  type Incident,
  type IncidentEvidenceReading,
  type IncidentType,
  type Reading,
  type Rules,
  type SourcePosition,
} from '@coldguard/shared';
import type { IncidentManager } from './incidents.js';

interface Pending {
  since: number;
  first: IncidentEvidenceReading;
  peak: IncidentEvidenceReading;
  n: number;
}

interface Runtime {
  info: DeviceInfo;
  pos: SourcePosition | null;
  state: DeviceState;
  lastReceivedWall: number | null;
  recent: { t: number; tc: number }[];
  spark: number[];
  sparkLastAt: number;
  pending: { high: Pending | null; low: Pending | null };
  driftCalmSince: number | null;
  offline: boolean;
  budgetSpent: boolean;
}

const SPARK_POINTS = 90;
const SPARK_EVERY_MS = 2000;

const TZ = process.env.DISPLAY_TZ || 'Asia/Kolkata';
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmtT = (ms: number) => timeFmt.format(ms);
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Device state + alert engine. Only *in-order* readings (per isNewerThan) are
 * applied; late readings are persisted and visible in history but never move
 * current state or alert state backwards. All rule timing uses device
 * observedAt so evaluation is deterministic and replayable; only offline
 * detection uses the server clock (time since last *received* reading).
 */
export class StateEngine {
  rules: Rules = { ...DEFAULT_RULES };
  private devs = new Map<string, Runtime>();
  /** groupId → deviceIds whose state changed since the last fleet emit. */
  private dirty = new Map<string, Set<string>>();
  private persistDirty = new Set<string>();
  lateCount = 0;

  constructor(private incidents: IncidentManager) {}

  register(devices: DeviceInfo[]) {
    for (const info of devices) {
      if (this.devs.has(info.id)) {
        this.devs.get(info.id)!.info = info;
        continue;
      }
      this.devs.set(info.id, {
        info,
        pos: null,
        state: {
          id: info.id,
          v: 0,
          status: 'offline',
          reasons: ['No data received yet'],
          t: null,
          r: null,
          tc: null,
          h: null,
          b: null,
          cs: null,
          progress: 0,
          door: null,
          exposure: 0,
          openIncidents: 0,
        },
        lastReceivedWall: null,
        recent: [],
        spark: [],
        sparkLastAt: 0,
        pending: { high: null, low: null },
        driftCalmSince: null,
        offline: true,
        budgetSpent: false,
      });
    }
  }

  restore(id: string, pos: SourcePosition | null, snap: Partial<DeviceState> & { spark?: number[] }) {
    const rt = this.devs.get(id);
    if (!rt) return;
    rt.pos = pos;
    const { spark, ...state } = snap;
    Object.assign(rt.state, state, { id });
    rt.spark = spark ?? [];
    rt.lastReceivedWall = rt.state.r;
    rt.offline = false;
    rt.budgetSpent = rt.state.exposure >= this.rules.exposureBudgetCMin;
    this.refreshStatus(rt, Date.now());
  }

  device(id: string): DeviceInfo | undefined {
    return this.devs.get(id)?.info;
  }
  position(id: string): SourcePosition | null {
    return this.devs.get(id)?.pos ?? null;
  }
  state(id: string): DeviceState | undefined {
    return this.devs.get(id)?.state;
  }
  spark(id: string): number[] {
    return this.devs.get(id)?.spark ?? [];
  }
  devicesIn(groups: string[]): DeviceInfo[] {
    const g = new Set(groups);
    return [...this.devs.values()].filter((d) => g.has(d.info.groupId)).map((d) => d.info);
  }
  allDevices(): DeviceInfo[] {
    return [...this.devs.values()].map((d) => d.info);
  }

  /** Decide lateness for a reading before persistence (does not mutate state). */
  classify(deviceId: string, pos: SourcePosition, provisional: Map<string, SourcePosition>): 'in-order' | 'late' {
    const cur = provisional.get(deviceId) ?? this.position(deviceId);
    if (isNewerThan(cur, pos)) {
      provisional.set(deviceId, pos);
      return 'in-order';
    }
    return 'late';
  }

  /** Apply persisted readings (in persistence order). */
  applyPersisted(readings: Reading[], wallNow = Date.now()) {
    for (const r of readings) {
      const rt = this.devs.get(r.d);
      if (!rt) continue;
      this.noteReceived(rt, r, wallNow);
      if (r.late) {
        this.lateCount++;
        continue;
      }
      const next = { sessionId: r.s, seq: r.q, observedAt: r.t };
      if (!isNewerThan(rt.pos, next)) {
        // Defensive: classification raced with a restore — never move backwards.
        this.lateCount++;
        continue;
      }
      rt.pos = next;
      const st = rt.state;
      if (st.t != null && st.tc != null) {
        st.exposure += excessDegMin({ t: st.t, tc: st.tc }, r, this.rules.tempLowC, this.rules.tempHighC); // unrounded: no drift
      }
      st.t = r.t;
      st.r = r.r;
      st.tc = r.tc;
      st.h = r.h;
      st.b = r.b;
      st.cs = r.cs;
      if (r.p !== undefined) st.progress = r.p;
      st.door = r.door ?? null;
      if (r.t - rt.sparkLastAt >= SPARK_EVERY_MS) {
        rt.spark.push(r1(r.tc));
        if (rt.spark.length > SPARK_POINTS) rt.spark.shift();
        rt.sparkLastAt = r.t;
      }
      this.evaluate(rt, r);
      this.refreshStatus(rt, r.t);
    }
  }

  /** Any persisted reading (even late) proves the logger is connected. */
  private noteReceived(rt: Runtime, r: Reading, wallNow: number) {
    rt.lastReceivedWall = wallNow;
    if (rt.offline) {
      rt.offline = false;
      const inc = this.incidents.get(rt.info.id, 'sensor_offline');
      if (inc) {
        const gapSec = Math.round((wallNow - (inc.evidence.lastSeenAt ?? wallNow)) / 1000);
        this.incidents.resolve(inc, wallNow, `Readings resumed after a ${gapSec} s gap (event ${r.id}).`);
      }
      this.markDirty(rt);
    }
  }

  /** Server-clock offline detection; call periodically. */
  tickOffline(wallNow = Date.now()) {
    const limit = this.rules.offlineSec * 1000;
    for (const rt of this.devs.values()) {
      if (rt.offline || rt.lastReceivedWall === null) continue;
      if (wallNow - rt.lastReceivedWall <= limit) continue;
      rt.offline = true;
      const last = rt.lastReceivedWall;
      this.incidents.open(
        this.newIncident(rt, 'sensor_offline', 'warning', last, wallNow, {
          explanation: `No readings received for ${this.rules.offlineSec} s (last received ${fmtT(last)}; rule: offline after ${this.rules.offlineSec} s without data).`,
          rule: { offlineSec: this.rules.offlineSec },
          evidence: { readings: 0, lastSeenAt: last },
        }),
      );
      this.refreshStatus(rt, wallNow);
    }
  }

  private evaluate(rt: Runtime, r: Reading) {
    const R = this.rules;
    const ev: IncidentEvidenceReading = { eventId: r.id, t: r.t, tc: r.tc };
    this.evalExcursion(rt, 'high', r, ev, R);
    this.evalExcursion(rt, 'low', r, ev, R);
    this.evalDrift(rt, r, ev, R);
    this.evalBattery(rt, r, ev, R);
    this.evalExposure(rt, r, ev, R);
  }

  /**
   * Heat-exposure budget (demo calculation, in the spirit of vial heat indicators):
   * cumulative °C·min outside the band, integrated over in-order readings
   * (trapezoid on the excess; gaps > 60 s are not integrated). Exposure only
   * accumulates — the incident resolves when the logger is back in range for
   * the recovery time, but the budget stays spent.
   */
  private evalExposure(rt: Runtime, r: Reading, ev: IncidentEvidenceReading, R: Rules) {
    const used = rt.state.exposure;
    const active = this.incidents.get(rt.info.id, 'exposure_budget');
    const inBand = r.tc <= R.tempHighC - R.hysteresisC && r.tc >= R.tempLowC + R.hysteresisC;
    if (!active) {
      if (used >= R.exposureBudgetCMin && !rt.budgetSpent) {
        rt.budgetSpent = true;
        this.incidents.open(
          this.newIncident(rt, 'exposure_budget', 'critical', r.t, r.t, {
            explanation:
              `Cumulative heat exposure reached ${used.toFixed(1)} °C·min, exhausting the ${R.exposureBudgetCMin} °C·min demo budget ` +
              `(integral of degrees outside ${R.tempLowC}–${R.tempHighC} °C over time; now ${r.tc.toFixed(1)} °C). Demo calculation — not a stability determination.`,
            rule: { exposureBudgetCMin: R.exposureBudgetCMin, tempLowC: R.tempLowC, tempHighC: R.tempHighC },
            evidence: { trigger: ev, readings: 1 },
          }),
        );
      }
      return;
    }
    if (inBand) {
      if (active.recoveringSince == null) active.recoveringSince = r.t;
      else if (r.t - active.recoveringSince >= R.recoverySec * 1000) {
        this.incidents.resolve(active, r.t, `Back in range for ${R.recoverySec} s. Budget remains spent: ${used.toFixed(1)} / ${R.exposureBudgetCMin} °C·min.`);
      }
    } else active.recoveringSince = null;
  }

  private evalExcursion(rt: Runtime, dir: 'high' | 'low', r: Reading, ev: IncidentEvidenceReading, R: Rules) {
    const type: IncidentType = dir === 'high' ? 'temp_high' : 'temp_low';
    const limit = dir === 'high' ? R.tempHighC : R.tempLowC;
    const breach = dir === 'high' ? r.tc > limit : r.tc < limit;
    const clear = dir === 'high' ? r.tc <= limit - R.hysteresisC : r.tc >= limit + R.hysteresisC;
    const worse = (a: number, b: number) => (dir === 'high' ? a > b : a < b);
    const active = this.incidents.get(rt.info.id, type);

    if (!active) {
      if (!breach) {
        rt.pending[dir] = null;
        return;
      }
      let p = rt.pending[dir];
      if (!p) p = rt.pending[dir] = { since: r.t, first: ev, peak: ev, n: 0 };
      p.n++;
      if (worse(r.tc, p.peak.tc)) p.peak = ev;
      if (r.t - p.since >= R.sustainSec * 1000) {
        const word = dir === 'high' ? 'above' : 'below';
        const cool = COOLING_FROM_CODE[r.cs] ?? 'unknown';
        this.incidents.open(
          this.newIncident(rt, type, 'critical', p.since, r.t, {
            explanation:
              `Temperature stayed ${word} ${limit.toFixed(1)} °C for ${Math.round((r.t - p.since) / 1000)} s ` +
              `(rule: ${word} limit sustained ≥ ${R.sustainSec} s). First breach ${p.first.tc.toFixed(2)} °C at ${fmtT(p.first.t)}, ` +
              `now ${r.tc.toFixed(1)} °C, peak ${p.peak.tc.toFixed(1)} °C across ${p.n} readings. Cooling unit reports "${cool}".`,
            rule: { [dir === 'high' ? 'tempHighC' : 'tempLowC']: limit, sustainSec: R.sustainSec, hysteresisC: R.hysteresisC, recoverySec: R.recoverySec },
            evidence: { first: p.first, trigger: ev, peak: p.peak, readings: p.n },
          }),
        );
        rt.pending[dir] = null;
        const drift = this.incidents.get(rt.info.id, 'rapid_drift');
        if (drift) this.incidents.resolve(drift, r.t, 'Escalated to a sustained temperature excursion.');
      }
      return;
    }

    // Active incident: track peak, then require `recoverySec` continuously inside the hysteresis band.
    let changed = false;
    if (breach) active.evidence.readings++;
    if (worse(r.tc, active.evidence.peak?.tc ?? limit) && Math.abs(r.tc - (active.evidence.peak?.tc ?? limit)) >= 0.2) {
      active.evidence.peak = ev;
      changed = true;
    }
    if (clear) {
      if (active.recoveringSince == null) {
        active.recoveringSince = r.t;
        active.timeline.push({
          at: r.t,
          kind: 'recovering',
          text: `Back inside ${dir === 'high' ? `${(limit - R.hysteresisC).toFixed(1)} °C (limit − hysteresis)` : `${(limit + R.hysteresisC).toFixed(1)} °C (limit + hysteresis)`} at ${r.tc.toFixed(1)} °C; resolves after ${R.recoverySec} s.`,
        });
        changed = true;
      } else if (r.t - active.recoveringSince >= R.recoverySec * 1000) {
        this.incidents.resolve(active, r.t, `Recovered: ${R.recoverySec} s continuously within range (now ${r.tc.toFixed(1)} °C).`);
        return;
      }
    } else if (active.recoveringSince != null) {
      active.recoveringSince = null;
      active.timeline.push({ at: r.t, kind: 'relapse', text: `Recovery interrupted at ${r.tc.toFixed(1)} °C.` });
      changed = true;
    }
    if (changed) this.incidents.save(active);
  }

  private evalDrift(rt: Runtime, r: Reading, ev: IncidentEvidenceReading, R: Rules) {
    const win = R.driftWindowSec * 1000;
    rt.recent.push({ t: r.t, tc: r.tc });
    while (rt.recent.length && rt.recent[0].t < r.t - win) rt.recent.shift();
    if (rt.recent.length > 600) rt.recent.splice(0, rt.recent.length - 600);
    const pts = rt.recent;
    if (pts.length < 8 || r.t - pts[0].t < win * 0.5) return;
    const slope = slopePerMin(pts);
    const active = this.incidents.get(rt.info.id, 'rapid_drift');
    const excursion = this.incidents.get(rt.info.id, 'temp_high') || this.incidents.get(rt.info.id, 'temp_low');
    if (!active) {
      if (!excursion && Math.abs(slope) >= R.driftCPerMin) {
        const first = pts[0];
        const dirWord = slope > 0 ? 'rising' : 'falling';
        rt.driftCalmSince = null;
        this.incidents.open(
          this.newIncident(rt, 'rapid_drift', 'warning', first.t, r.t, {
            explanation:
              `Temperature ${dirWord} at ${Math.abs(slope).toFixed(2)} °C/min over the last ${Math.round((r.t - first.t) / 1000)} s ` +
              `(${first.tc.toFixed(1)} → ${r.tc.toFixed(1)} °C; rule: |slope| ≥ ${R.driftCPerMin} °C/min over ${R.driftWindowSec} s, least-squares fit of ${pts.length} readings). ` +
              `Early warning: the ${R.tempLowC}–${R.tempHighC} °C band may be breached.`,
            rule: { driftCPerMin: R.driftCPerMin, driftWindowSec: R.driftWindowSec },
            evidence: { first: { eventId: '', t: first.t, tc: first.tc }, trigger: ev, readings: pts.length, slopeCPerMin: r1(slope * 100) / 100 },
          }),
        );
      }
      return;
    }
    if (Math.abs(slope) < R.driftCPerMin / 2) {
      if (rt.driftCalmSince == null) rt.driftCalmSince = r.t;
      else if (r.t - rt.driftCalmSince >= R.recoverySec * 1000) {
        rt.driftCalmSince = null;
        this.incidents.resolve(active, r.t, `Drift settled: |slope| ${Math.abs(slope).toFixed(2)} °C/min below ${R.driftCPerMin / 2} °C/min for ${R.recoverySec} s.`);
      }
    } else rt.driftCalmSince = null;
  }

  private evalBattery(rt: Runtime, r: Reading, ev: IncidentEvidenceReading, R: Rules) {
    const active = this.incidents.get(rt.info.id, 'low_battery');
    if (!active && r.b < R.lowBatteryPct) {
      this.incidents.open(
        this.newIncident(rt, 'low_battery', 'warning', r.t, r.t, {
          explanation: `Logger battery at ${r.b.toFixed(0)} % (rule: below ${R.lowBatteryPct} %). Telemetry may stop when it is exhausted.`,
          rule: { lowBatteryPct: R.lowBatteryPct },
          evidence: { trigger: ev, readings: 1 },
        }),
      );
    } else if (active && r.b >= R.lowBatteryPct + 5) {
      this.incidents.resolve(active, r.t, `Battery back to ${r.b.toFixed(0)} % (≥ ${R.lowBatteryPct + 5} %, 5 % hysteresis).`);
    }
  }

  private newIncident(
    rt: Runtime,
    type: IncidentType,
    severity: 'warning' | 'critical',
    openedAt: number,
    triggeredAt: number,
    x: Pick<Incident, 'explanation' | 'rule' | 'evidence'>,
  ): Incident {
    return {
      id: `${rt.info.id}-${type}-${triggeredAt}`,
      deviceId: rt.info.id,
      groupId: rt.info.groupId,
      type,
      severity,
      state: 'open',
      active: true,
      openedAt,
      triggeredAt,
      recoveringSince: null,
      timeline: [{ at: triggeredAt, kind: 'opened', text: x.explanation }],
      ...x,
    };
  }

  /** Recompute status from active incidents + pending breaches. Called after each change. */
  refreshStatus(rt: Runtime, at: number) {
    const st = rt.state;
    const act = this.incidents.activeFor(rt.info.id);
    const has = (t: IncidentType) => act.find((i) => i.type === t);
    const reasons: string[] = [];
    let status: DeviceState['status'] = 'healthy';
    const R = this.rules;
    const ex = has('temp_high') || has('temp_low');
    if (ex) {
      status = 'critical';
      reasons.push(ex.type === 'temp_high' ? `Above ${R.tempHighC} °C for ≥ ${R.sustainSec} s` : `Below ${R.tempLowC} °C for ≥ ${R.sustainSec} s`);
      if (ex.recoveringSince) reasons.push('Recovering');
      if (st.exposure >= R.exposureBudgetCMin) reasons.push(`Heat budget spent (${st.exposure.toFixed(1)} °C·min)`);
      else if (st.exposure >= R.exposureBudgetCMin / 2) reasons.push(`Heat budget ${Math.round((st.exposure / R.exposureBudgetCMin) * 100)} % used`);
    } else if (rt.offline) {
      status = rt.lastReceivedWall === null ? 'offline' : 'offline';
      reasons.push(rt.lastReceivedWall === null ? 'No data received yet' : `No data for > ${R.offlineSec} s`);
    } else {
      const p = rt.pending.high ?? rt.pending.low;
      if (p) reasons.push(`Outside ${R.tempLowC}–${R.tempHighC} °C for ${Math.round((at - p.since) / 1000)} s (alert at ${R.sustainSec} s)`);
      const dr = has('rapid_drift');
      if (dr) {
        const sl = dr.evidence.slopeCPerMin ?? 0;
        reasons.push(`Temp ${sl >= 0 ? 'rising' : 'falling'} ${Math.abs(sl).toFixed(1)} °C/min`);
      }
      if (has('low_battery')) reasons.push(`Battery ${st.b?.toFixed(0)} %`);
      if (st.cs === 2) reasons.push('Cooling unit fault');
      if (st.cs === 3) reasons.push('Running on backup cooling');
      if (st.door === 1) reasons.push('Compartment door open');
      const pct = (st.exposure / R.exposureBudgetCMin) * 100;
      if (pct >= 100) reasons.push(`Heat budget spent (${st.exposure.toFixed(1)} °C·min)`);
      else if (pct >= 50) reasons.push(`Heat budget ${Math.round(pct)} % used`);
      if (reasons.length) status = 'warning';
    }
    if (rt.offline && ex) reasons.push('Offline');
    if (has('exposure_budget') && status !== 'offline') status = 'critical';
    const changedStatus = status !== st.status || reasons.join('|') !== st.reasons.join('|') || act.length !== st.openIncidents;
    st.status = status;
    st.reasons = reasons;
    st.openIncidents = act.length;
    st.v++;
    this.markDirty(rt);
    return changedStatus;
  }

  /** Called when an incident changes outside the reading path (ack, resolve). */
  touch(deviceId: string) {
    const rt = this.devs.get(deviceId);
    if (rt) this.refreshStatus(rt, rt.state.t ?? Date.now());
  }

  private markDirty(rt: Runtime) {
    let s = this.dirty.get(rt.info.groupId);
    if (!s) this.dirty.set(rt.info.groupId, (s = new Set()));
    s.add(rt.info.id);
    this.persistDirty.add(rt.info.id);
  }

  takeDirty(): Map<string, Set<string>> {
    const d = this.dirty;
    this.dirty = new Map();
    return d;
  }

  takePersistDirty(): { id: string; pos: SourcePosition | null; snapshot: DeviceState & { spark: number[] } }[] {
    const out = [...this.persistDirty].map((id) => {
      const rt = this.devs.get(id)!;
      return { id, pos: rt.pos, snapshot: { ...rt.state, spark: rt.spark } };
    });
    this.persistDirty.clear();
    return out;
  }

  reset() {
    const infos = this.allDevices();
    this.devs.clear();
    this.dirty.clear();
    this.persistDirty.clear();
    this.lateCount = 0;
    this.register(infos);
  }
}

export function slopePerMin(pts: { t: number; tc: number }[]): number {
  const n = pts.length;
  const t0 = pts[0].t;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (const p of pts) {
    const x = (p.t - t0) / 60000;
    sx += x;
    sy += p.tc;
    sxx += x * x;
    sxy += x * p.tc;
  }
  const den = n * sxx - sx * sx;
  return den === 0 ? 0 : (n * sxy - sx * sy) / den;
}
