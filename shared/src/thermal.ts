import type { DeviceInfo } from './wire.js';
import type { TelemetryEventIn } from './schemas.js';

/** Seedable PRNG (mulberry32) with copyable state, so a model can be cloned exactly. */
export class Rng {
  constructor(public a: number) {
    this.a = a >>> 0;
  }
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gauss(): number {
    const u = Math.max(this.next(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
}

export interface ThermalState {
  temp: number;
  hum: number;
  battery: number;
  cooling: 'on' | 'off' | 'fault' | 'backup';
  compressorFailed: boolean;
  backupActive: boolean;
  doorOpen: boolean;
  recoveringBoost: number; // seconds of boosted primary cooling after a repair
  batteryDrain: number; // extra %/s
}

/**
 * Thermal model of one refrigerated logger (all values simulated):
 *  - heat leaks from a 26–32 °C ambient with time constant τ (1800 s truck, 3600 s cold room);
 *  - a thermostat cycles the compressor between 3.8 and 5.6 °C (sawtooth);
 *  - compressor failure: no primary cooling and a worse seal (τ 420 s) ⇒ ≈3 °C/min rise;
 *  - open door: τ 300 s and humidity pulled towards the outside air;
 *  - backup cooling: weaker auxiliary unit (enough to recover slowly with the door closed);
 *  - primary restore: boosted cooling until the reading is back in the band.
 */
export class ThermalModel {
  s: ThermalState;
  rng: Rng;
  readonly phase: number;
  readonly tripSec: number;

  constructor(
    public info: Pick<DeviceInfo, 'id' | 'kind'>,
    seed: number,
    index: number,
  ) {
    this.rng = new Rng(seed * 7919 + index * 104729);
    this.s = {
      temp: 4.2 + this.rng.next() * 1.4,
      hum: 45 + this.rng.next() * 10,
      battery: 55 + this.rng.next() * 45,
      cooling: 'on',
      compressorFailed: false,
      backupActive: false,
      doorOpen: false,
      recoveringBoost: 0,
      batteryDrain: 0,
    };
    this.phase = this.rng.next();
    this.tripSec = 1200 + Math.floor(this.rng.next() * 1800);
  }

  clone(): ThermalModel {
    const c = Object.create(ThermalModel.prototype) as ThermalModel;
    Object.assign(c, { info: this.info, phase: this.phase, tripSec: this.tripSec });
    c.s = { ...this.s };
    c.rng = new Rng(this.rng.a);
    return c;
  }

  /** Advance the physics by dtSec at wall time `now`. */
  advance(dtSec: number, now: number) {
    const s = this.s;
    const ambient = 29 + 3 * Math.sin((now / 3_600_000) * 2 * Math.PI + this.phase * 6);
    let tau = this.info.kind === 'facility' ? 3600 : 1800;
    if (s.compressorFailed) tau = 420;
    if (s.doorOpen) tau = Math.min(tau, 300);
    let dT = ((ambient - s.temp) / tau) * dtSec;

    if (s.compressorFailed) {
      if (s.backupActive) {
        s.cooling = 'backup';
        dT -= 0.075 * dtSec;
      } else s.cooling = 'fault';
    } else {
      if (s.cooling === 'fault' || s.cooling === 'backup') s.cooling = 'on';
      if (s.temp > 5.6) s.cooling = 'on';
      else if (s.temp < 3.8 && s.recoveringBoost <= 0) s.cooling = 'off';
      if (s.cooling === 'on') dT -= (s.recoveringBoost > 0 ? 0.08 : 0.022) * dtSec;
      if (s.recoveringBoost > 0) {
        s.recoveringBoost -= dtSec;
        if (s.temp < 5) s.recoveringBoost = 0;
      }
    }
    dT += this.rng.gauss() * 0.03 * Math.sqrt(dtSec);
    s.temp = Math.max(-5, Math.min(45, s.temp + dT));

    const humTarget = s.doorOpen ? 78 : 46 + (s.temp - 5) * 1.6;
    s.hum += (humTarget - s.hum) * (s.doorOpen ? 0.06 : 0.1) * Math.min(dtSec, 5) + this.rng.gauss() * 0.4;
    s.hum = Math.max(5, Math.min(98, s.hum));
    s.battery = Math.max(0, s.battery - (0.0015 + s.batteryDrain) * dtSec);
  }

  metrics(now: number): TelemetryEventIn['metrics'] {
    const s = this.s;
    const m: TelemetryEventIn['metrics'] = {
      tempC: Math.round(s.temp * 100) / 100,
      humidityPct: Math.round(s.hum * 10) / 10,
      batteryPct: Math.round(s.battery * 10) / 10,
      cooling: s.cooling,
      doorOpen: s.doorOpen,
    };
    if (this.info.kind === 'shipment') m.routeProgress = Math.round((((now / 1000) / this.tripSec + this.phase) % 1) * 1000) / 1000;
    return m;
  }

  // ---- faults & commands ---------------------------------------------------
  failCompressor() {
    this.s.compressorFailed = true;
    this.s.backupActive = false;
  }
  openDoor() {
    this.s.doorOpen = true;
  }
  closeDoor() {
    this.s.doorOpen = false;
  }
  activateBackup() {
    this.s.backupActive = true;
  }
  restorePrimary() {
    const wasDown = this.s.compressorFailed || this.s.temp > 6;
    this.s.compressorFailed = false;
    this.s.backupActive = false;
    if (wasDown) this.s.recoveringBoost = 900; // boost until back under 5 °C (cap 15 min)
  }
  repairAll() {
    this.restorePrimary();
    this.s.doorOpen = false;
    this.s.batteryDrain = 0;
  }

  /**
   * SIMULATED counterfactual: clone the current state and continue WITHOUT any
   * intervention for `horizonSec`, sampling every `stepSec`. Same physics and
   * noise model — a what-if, not a forecast of the real world.
   */
  project(from: number, horizonSec: number, stepSec = 10): [number, number][] {
    const c = this.clone();
    const out: [number, number][] = [[from, Math.round(c.s.temp * 100) / 100]];
    for (let t = stepSec; t <= horizonSec; t += stepSec) {
      for (let k = 0; k < stepSec; k++) c.advance(1, from + (t - stepSec + k + 1) * 1000);
      out.push([from + t * 1000, Math.round(c.s.temp * 100) / 100]);
    }
    return out;
  }
}

/** Per-source sequencing wrapper used by the simulator and by phone "trucks". */
export class SimLogger {
  seq = 0;
  constructor(
    public model: ThermalModel,
    public sessionId: string,
  ) {}
  step(dtSec: number, now: number): TelemetryEventIn {
    this.model.advance(dtSec, now);
    const seq = this.seq++;
    const deviceId = this.model.info.id;
    return { eventId: `${deviceId}:${this.sessionId}:${seq}`, deviceId, sessionId: this.sessionId, seq, observedAt: now, metrics: this.model.metrics(now) };
  }
}

/** Degree-minutes outside [low, high] between two readings (trapezoid on the excess). */
export function excessDegMin(a: { t: number; tc: number }, b: { t: number; tc: number }, low: number, high: number, maxGapMs = 60_000): number {
  const dt = b.t - a.t;
  if (dt <= 0 || dt > maxGapMs) return 0;
  const ex = (v: number) => (v > high ? v - high : v < low ? low - v : 0);
  return ((ex(a.tc) + ex(b.tc)) / 2) * (dt / 60_000);
}
