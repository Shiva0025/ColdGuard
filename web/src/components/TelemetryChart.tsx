import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import type { Incident, Rules } from '@coldguard/shared';
import type { DeviceStream } from '../lib/deviceStream';
import { realtime } from '../lib/realtime';

const C = {
  axis: '#64748b',
  grid: '#e6ecf3',
  temp: '#0891b2',
  band: 'rgba(8,145,178,0.16)',
  late: '#7c3aed',
  hum: '#0d9488',
  bat: '#ca8a04',
  ok: 'rgba(5,150,105,0.08)',
  bad: 'rgba(220,38,38,0.06)',
  crit: '#dc2626',
  warn: '#d97706',
  okLine: '#059669',
};

interface Built {
  main: uPlot.AlignedData;
  sub: uPlot.AlignedData;
  fault: [number, number][];
  door: [number, number][];
}

/** Turn the stream window (+ buckets) into column arrays. Gaps > 3× cadence become nulls. */
function build(stream: DeviceStream): Built {
  const xs: number[] = [];
  const t: (number | null)[] = [];
  const lo: (number | null)[] = [];
  const hi: (number | null)[] = [];
  const late: (number | null)[] = [];
  const hum: (number | null)[] = [];
  const bat: (number | null)[] = [];
  const fault: [number, number][] = [];
  let faultStart: number | null = null;
  const door: [number, number][] = [];
  let doorStart: number | null = null;
  let prevX = 0;
  const gapAfter = Math.max(5, (stream.bucketMs / 1000) * 3);
  const push = (x: number, tv: number | null, l: number | null, h: number | null, lt: number | null, hv: number | null, bv: number | null, isFault: boolean, isDoor = false) => {
    if (isDoor && doorStart == null) doorStart = x;
    if (!isDoor && doorStart != null) {
      door.push([doorStart, x]);
      doorStart = null;
    }
    if (prevX && x - prevX > gapAfter) {
      xs.push(prevX + 0.001);
      t.push(null);
      lo.push(null);
      hi.push(null);
      late.push(null);
      hum.push(null);
      bat.push(null);
    }
    xs.push(x);
    t.push(tv);
    lo.push(l);
    hi.push(h);
    late.push(lt);
    hum.push(hv);
    bat.push(bv);
    if (isFault && faultStart == null) faultStart = x;
    if (!isFault && faultStart != null) {
      fault.push([faultStart, x]);
      faultStart = null;
    }
    prevX = x;
  };
  if (stream.mode === 'agg') {
    const from = stream.from - stream.bucketMs;
    for (const b of stream.buckets) {
      if (b.t < from) continue;
      push((b.t + stream.bucketMs / 2) / 1000, b.tAvg, b.tMin, b.tMax, null, b.h, b.b, b.fault > 0);
    }
  }
  for (const r of stream.window.items) {
    if (r.t / 1000 <= prevX) {
      // Same-timestamp readings from a new session: nudge to keep x strictly increasing.
      push(prevX + 0.001, r.tc, null, null, r.late ? r.tc : null, r.h, r.b, r.cs === 2, r.door === 1);
    } else push(r.t / 1000, r.tc, null, null, r.late ? r.tc : null, r.h, r.b, r.cs === 2, r.door === 1);
  }
  if (faultStart != null) fault.push([faultStart, prevX]);
  if (doorStart != null) door.push([doorStart, prevX]);
  return { main: [xs, t, lo, hi, late], sub: [xs, hum, bat], fault, door };
}

export function TelemetryChart({
  stream,
  version,
  rules,
  incidents,
}: {
  stream: DeviceStream;
  version: number;
  rules: Rules | null;
  incidents: Incident[];
}) {
  const mainRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const plots = useRef<{ main: uPlot; sub: uPlot } | null>(null);
  const programmatic = useRef(false);
  const ctx = useRef({ rules, incidents, fault: [] as [number, number][], door: [] as [number, number][], stream });
  ctx.current.rules = rules;
  ctx.current.incidents = incidents;
  ctx.current.stream = stream;

  // Create plots once per stream.
  useEffect(() => {
    const el = mainRef.current!;
    const subEl = subRef.current!;
    const width = el.clientWidth || 600;
    const axis = (label: string, scale: string, side: 1 | 3 = 3): uPlot.Axis => ({
      scale,
      side,
      label,
      labelSize: 18,
      labelFont: '600 11px Inter, system-ui',
      font: '11px Inter, system-ui',
      stroke: C.axis,
      grid: { stroke: C.grid, width: 1 },
      ticks: { stroke: C.grid, width: 1 },
      size: 48,
    });
    const xAxis: uPlot.Axis = { stroke: C.axis, font: '11px Inter, system-ui', grid: { stroke: C.grid, width: 1 }, ticks: { stroke: C.grid } };

    const drawOverlay = (u: uPlot) => {
      const { rules: R, incidents: inc, fault, door } = ctx.current;
      const c = u.ctx;
      const { left, top, width: w, height: h } = u.bbox;
      c.save();
      c.beginPath();
      c.rect(left, top, w, h);
      c.clip();
      c.textAlign = 'left';
      c.textBaseline = 'alphabetic';
      if (R) {
        const yHi = u.valToPos(R.tempHighC, 'y', true);
        const yLo = u.valToPos(R.tempLowC, 'y', true);
        c.fillStyle = C.ok;
        c.fillRect(left, yHi, w, yLo - yHi);
        c.fillStyle = C.bad;
        c.fillRect(left, top, w, Math.max(0, yHi - top));
        c.fillRect(left, yLo, w, Math.max(0, top + h - yLo));
        c.setLineDash([5, 4]);
        c.lineWidth = 1;
        c.strokeStyle = 'rgba(220,38,38,0.7)';
        for (const [v, lab] of [
          [R.tempHighC, `high ${R.tempHighC.toFixed(1)} °C`],
          [R.tempLowC, `low ${R.tempLowC.toFixed(1)} °C`],
        ] as const) {
          const y = u.valToPos(v, 'y', true);
          c.beginPath();
          c.moveTo(left, y);
          c.lineTo(left + w, y);
          c.stroke();
          c.fillStyle = 'rgba(185,28,28,0.95)';
          c.font = `${11 * devicePixelRatio}px Inter, system-ui`;
          c.fillText(lab, left + 6 * devicePixelRatio, y - 4 * devicePixelRatio);
        }
        c.setLineDash([]);
      }
      // Cooling fault strip along the bottom.
      c.fillStyle = 'rgba(220,38,38,0.85)';
      for (const [a, b] of fault) {
        const x0 = u.valToPos(a, 'x', true);
        const x1 = u.valToPos(b, 'x', true);
        c.fillRect(x0, top + h - 5 * devicePixelRatio, Math.max(2, x1 - x0), 5 * devicePixelRatio);
      }
      // Door-open strip just above the fault strip.
      c.fillStyle = 'rgba(217,119,6,0.9)';
      for (const [a, b] of door) {
        const x0 = u.valToPos(a, 'x', true);
        const x1 = u.valToPos(b, 'x', true);
        c.fillRect(x0, top + h - 11 * devicePixelRatio, Math.max(2, x1 - x0), 5 * devicePixelRatio);
      }
      // Incident markers.
      c.font = `600 ${10.5 * devicePixelRatio}px Inter, system-ui`;
      inc.forEach((i, idx) => {
        const name = i.type === 'rapid_drift' ? 'drift' : i.type === 'sensor_offline' ? 'offline' : i.type === 'low_battery' ? 'battery' : 'excursion';
        const marks: [number | undefined, string, string, boolean][] = [
          [i.type === 'temp_high' || i.type === 'temp_low' ? i.openedAt : undefined, i.severity === 'critical' ? C.crit : C.warn, '', true],
          [i.triggeredAt, i.severity === 'critical' ? C.crit : C.warn, `▲ ${name}`, false],
          [i.ack?.at, '#0891b2', 'ack', true],
          [i.resolvedAt, C.okLine, `✓ ${name}`, false],
        ];
        const row = (idx % 3) * 13 * devicePixelRatio;
        for (const [ms, col, lab, dashed] of marks) {
          if (!ms) continue;
          const x = u.valToPos(ms / 1000, 'x', true);
          if (x < left || x > left + w) continue;
          c.strokeStyle = col;
          c.lineWidth = dashed ? 1 : 1.5 * devicePixelRatio;
          c.setLineDash(dashed ? [3, 3] : []);
          c.beginPath();
          c.moveTo(x, top);
          c.lineTo(x, top + h);
          c.stroke();
          c.setLineDash([]);
          if (lab) {
            c.fillStyle = col;
            c.fillText(lab, x + 4 * devicePixelRatio, top + 12 * devicePixelRatio + row);
          }
        }
      });
      c.restore();
    };

    programmatic.current = true; // construction and resizes are not user gestures
    const main = new uPlot(
      {
        width,
        height: 300,
        cursor: { sync: { key: 'cg' }, drag: { x: true, y: false, setScale: true }, points: { size: 6 } },
        scales: {
          x: { time: true },
          y: {
            range: (_u, mn, mx) => {
              const R = ctx.current.rules;
              const lo = Math.min(mn ?? 2, (R?.tempLowC ?? 2) - 1.5);
              const hi = Math.max(mx ?? 8, (R?.tempHighC ?? 8) + 1.5);
              return [Math.floor(lo), Math.ceil(hi)];
            },
          },
        },
        axes: [xAxis, axis('Temperature (°C)', 'y')],
        series: [
          {},
          { label: 'Temperature °C', stroke: C.temp, width: 1.75, spanGaps: false, points: { show: false } },
          { label: 'Bucket min', stroke: 'transparent', points: { show: false } },
          { label: 'Bucket max', stroke: 'transparent', points: { show: false } },
          { label: 'Late reading', stroke: C.late, paths: () => null, points: { show: true, size: 7, fill: C.late, stroke: C.late } },
        ],
        bands: [{ series: [3, 2], fill: C.band }],
        legend: { show: false },
        hooks: {
          drawClear: [],
          draw: [drawOverlay],
          setScale: [
            (u, key) => {
              if (key !== 'x') return;
              const sub = plots.current?.sub;
              const { min, max } = u.scales.x;
              if (sub && min != null && max != null) sub.setScale('x', { min, max });
            },
          ],
        },
      },
      [[], [], [], [], []],
      el,
    );
    const sub = new uPlot(
      {
        width,
        height: 130,
        cursor: { sync: { key: 'cg' }, drag: { x: false, y: false } },
        scales: { x: { time: true }, h: { range: [0, 100] }, b: { range: [0, 100] } },
        axes: [xAxis, axis('Humidity %RH', 'h'), { ...axis('Battery %', 'b', 1), grid: { show: false } }],
        series: [
          {},
          { label: 'Humidity %RH', stroke: C.hum, width: 1.25, scale: 'h', spanGaps: false },
          { label: 'Battery %', stroke: C.bat, width: 1.25, scale: 'b', spanGaps: false },
        ],
        legend: { show: false },
      },
      [[], [], []],
      subEl,
    );
    plots.current = { main, sub };
    programmatic.current = false;
    // uPlot commits scale changes asynchronously, so detect the user's gesture directly:
    // a horizontal drag (zoom) or double-click (reset) on the plot freezes "follow live".
    let downX: number | null = null;
    const over = main.over;
    const onDown = (e: MouseEvent) => (downX = e.clientX);
    const onUp = (e: MouseEvent) => {
      if (downX != null && Math.abs(e.clientX - downX) > 4) ctx.current.stream.pause();
      downX = null;
    };
    const onDbl = () => ctx.current.stream.pause();
    over.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    over.addEventListener('dblclick', onDbl);
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w > 0) {
        programmatic.current = true;
        main.setSize({ width: w, height: 300 });
        sub.setSize({ width: w, height: 130 });
        programmatic.current = false;
      }
    });
    ro.observe(el);
    return () => {
      over.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      over.removeEventListener('dblclick', onDbl);
      ro.disconnect();
      main.destroy();
      sub.destroy();
      plots.current = null;
    };
  }, [stream]);

  // Push data at the stream's render cadence (≤ 4 Hz), not per event.
  useEffect(() => {
    const p = plots.current;
    if (!p) return;
    const b = build(stream);
    ctx.current.fault = b.fault;
    ctx.current.door = b.door;
    programmatic.current = true;
    try {
      if (stream.following) {
        p.main.setData(b.main, false);
        p.sub.setData(b.sub, false);
        const now = (Date.now() + realtime.clockOffset) / 1000;
        const min = now - stream.rangeMs / 1000;
        p.main.setScale('x', { min, max: now + 2 });
        p.sub.setScale('x', { min, max: now + 2 });
      } else {
        // Paused / zoomed: keep the user's x-range, just refresh series.
        const { min, max } = p.main.scales.x;
        p.main.setData(b.main, false);
        p.sub.setData(b.sub, false);
        if (min != null && max != null) {
          p.main.setScale('x', { min, max });
          p.sub.setScale('x', { min, max });
        }
      }
    } finally {
      programmatic.current = false;
    }
  }, [stream, version, incidents, rules]);

  return (
    <div className="min-w-0">
      <div ref={mainRef} className="w-full" aria-label="Temperature chart with threshold band and alert markers" role="img" />
      <div ref={subRef} className="mt-1 w-full" aria-label="Humidity and battery chart" role="img" />
    </div>
  );
}
