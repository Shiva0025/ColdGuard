import { describe, expect, it } from 'vitest';
import { ReadingWindow, compareReadings, isNewerThan, mergeHistoryAndLive } from '../src/merge.js';
import type { Reading } from '../src/wire.js';

let cursor = 0;
function rd(d: string, q: number, t: number, s = 's1'): Reading {
  return { id: `${d}:${s}:${q}`, d, s, q, t, r: t + 5, c: ++cursor, tc: 5, h: 50, b: 90, cs: 1 };
}

describe('ReadingWindow', () => {
  it('deduplicates by eventId and keeps deterministic order for any arrival order', () => {
    const events = Array.from({ length: 50 }, (_, i) => rd('A', i, 1000 + i * 10));
    const shuffled = [...events].sort(() => Math.random() - 0.5);
    const w1 = new ReadingWindow({ maxPoints: 1000 });
    w1.insert(shuffled);
    w1.insert(shuffled.slice(0, 20)); // duplicates
    const w2 = new ReadingWindow({ maxPoints: 1000 });
    w2.insert(events);
    expect(w1.items.map((r) => r.id)).toEqual(w2.items.map((r) => r.id));
    expect(w1.size).toBe(50);
    expect(w1.duplicatesDropped).toBe(20);
  });

  it('places a late (out-of-order) reading at its observed position', () => {
    const w = new ReadingWindow({ maxPoints: 100 });
    w.insert([rd('A', 1, 100), rd('A', 3, 300)]);
    w.insert([rd('A', 2, 200)]);
    expect(w.items.map((r) => r.q)).toEqual([1, 2, 3]);
  });

  it('breaks ties on equal timestamps deterministically', () => {
    const a = rd('B', 1, 100);
    const b = rd('A', 1, 100);
    expect(compareReadings(b, a)).toBeLessThan(0);
  });

  it('is bounded and evicts oldest', () => {
    const w = new ReadingWindow({ maxPoints: 10 });
    w.insert(Array.from({ length: 25 }, (_, i) => rd('A', i, i)));
    expect(w.size).toBe(10);
    expect(w.items[0].q).toBe(15);
    expect(w.evicted).toBe(15);
  });
});

describe('mergeHistoryAndLive', () => {
  it('loses nothing and duplicates nothing when live events overlap history', () => {
    const all = Array.from({ length: 100 }, (_, i) => rd('A', i, i * 1000));
    // history snapshot saw 0..69; live buffer (subscribed before the query) saw 60..99
    const merged = mergeHistoryAndLive(all.slice(0, 70), all.slice(60).reverse(), 10_000);
    expect(merged.items.map((r) => r.q)).toEqual(all.map((r) => r.q));
  });
});

describe('isNewerThan (current-state policy)', () => {
  it('uses seq within a session', () => {
    expect(isNewerThan({ sessionId: 'a', seq: 5, observedAt: 500 }, { sessionId: 'a', seq: 4, observedAt: 900 })).toBe(false);
    expect(isNewerThan({ sessionId: 'a', seq: 5, observedAt: 500 }, { sessionId: 'a', seq: 6, observedAt: 400 })).toBe(true);
  });
  it('accepts a new session only when it is later in time', () => {
    expect(isNewerThan({ sessionId: 'a', seq: 500, observedAt: 500 }, { sessionId: 'b', seq: 0, observedAt: 600 })).toBe(true);
    expect(isNewerThan({ sessionId: 'b', seq: 3, observedAt: 600 }, { sessionId: 'a', seq: 501, observedAt: 550 })).toBe(false);
  });
});
