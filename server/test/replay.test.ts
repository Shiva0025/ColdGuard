import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, type Incident, type Reading } from '@coldguard/shared';
import { buildStory } from '../src/replay.js';

const t0 = Date.UTC(2026, 10, 13, 8, 30, 0);
function series(): Reading[] {
  const out: Reading[] = [];
  for (let i = 0; i < 600; i++) {
    const t = t0 + i * 1000;
    const door = i >= 200 && i < 420 ? 1 : 0; // door open 3 min 40 s
    // Flat ~4.8 °C until 20 s after the door opens, then +3 °C/min.
    const tc = i < 220 ? 4.8 + Math.sin(i / 7) * 0.05 : 4.8 + ((i - 220) * 3) / 60;
    const h = door ? Math.min(78, 46 + (i - 200) * 0.5) : 46;
    out.push({ id: `X:s:${i}`, d: 'X', s: 's', q: i, t, r: i >= 500 && i < 540 ? t + 40_000 : t + 50, c: i + 1, tc, h, b: 80, cs: 1, door: door as 0 | 1 });
  }
  return out;
}

describe('incident replay story', () => {
  const readings = series();
  const breach = readings.find((r) => r.tc > 8)!;
  const incident: Incident = {
    id: 'inc', deviceId: 'X', groupId: 'g', type: 'temp_high', severity: 'critical', state: 'open', active: true,
    openedAt: breach.t, triggeredAt: breach.t + 20_000, explanation: 'x', rule: {}, evidence: { readings: 1 }, timeline: [],
  };
  const story = buildStory({ readings, incident, related: [], commands: [], rules: DEFAULT_RULES, tz: 'UTC' });

  it('orders derived events and finds onset, door and breach', () => {
    const kinds = story.events.map((e) => e.kind);
    expect(kinds.indexOf('door_open')).toBeLessThan(kinds.indexOf('first_breach'));
    expect(story.firstBreachAt).toBe(breach.t);
    expect(Math.abs(story.onsetAt! - (t0 + 220_000))).toBeLessThanOrEqual(15_000);
    expect(story.events.every((e, i, a) => i === 0 || a[i - 1].t <= e.t)).toBe(true);
  });

  it('names the door as a POSSIBLE factor with evidence and a causation caveat', () => {
    const f = story.factors.find((x) => /door/.test(x.title))!;
    expect(f.title).toMatch(/^Possible contributing factor: prolonged door opening/);
    expect(f.evidence.join(' ')).toMatch(/3 min 40 s/);
    expect(f.caveat).toMatch(/cannot prove cause/);
  });

  it('reports buffered readings that were delivered late', () => {
    expect(story.events.find((e) => e.kind === 'backfill')?.detail).toMatch(/^40 readings/);
  });

  it('does not invent a factor when nothing was recorded', () => {
    const plain = readings.map((r) => ({ ...r, door: 0 as const }));
    const s2 = buildStory({ readings: plain, incident, related: [], commands: [], rules: DEFAULT_RULES, tz: 'UTC' });
    expect(s2.factors).toHaveLength(1);
    expect(s2.factors[0].title).toMatch(/No recorded door or cooling event/);
  });
});
