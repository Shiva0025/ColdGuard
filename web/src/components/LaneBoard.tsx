import { memo, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { CITIES, type DeviceInfo, type DeviceState } from '@coldguard/shared';
import { STATUS_META, fmtTemp } from '../lib/format';
import { statusKey } from './bits';

const W = 520;
const H = 440;
const LON = [71.6, 81.6];
const LAT = [10.3, 24.0];
const px = (lon: number) => 30 + ((lon - LON[0]) / (LON[1] - LON[0])) * (W - 60);
const py = (lat: number) => H - 20 - ((lat - LAT[0]) / (LAT[1] - LAT[0])) * (H - 40);

/**
 * Schematic lane board: approximate city positions (equirectangular), lanes
 * as straight segments, shipments placed by their reported route progress.
 * No map tiles — it works offline and costs nothing.
 */
export const LaneBoard = memo(function LaneBoard({
  devices,
  states,
  highlight,
}: {
  devices: DeviceInfo[];
  states: Map<string, DeviceState>;
  highlight?: string | null;
}) {
  const nav = useNavigate();
  const lanes = useMemo(() => {
    const seen = new Set<string>();
    const out: { a: string; b: string; g: string }[] = [];
    for (const d of devices) {
      if (d.kind !== 'shipment' || !CITIES[d.origin] || !CITIES[d.destination]) continue;
      const k = [d.origin, d.destination].sort().join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ a: d.origin, b: d.destination, g: d.groupId });
    }
    return out;
  }, [devices]);
  const cities = useMemo(() => {
    const s = new Set<string>();
    devices.forEach((d) => {
      if (CITIES[d.origin]) s.add(d.origin);
      if (CITIES[d.destination]) s.add(d.destination);
    });
    return [...s];
  }, [devices]);

  const plotted = devices.filter((d) => CITIES[d.origin]);
  // Draw critical last so it sits on top.
  const order = { healthy: 0, nodata: 0, offline: 1, warning: 2, critical: 3 } as const;
  plotted.sort((a, b) => order[statusKey(states.get(a.id))] - order[statusKey(states.get(b.id))]);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" role="group" aria-label="Lane board: shipments and cold rooms by location">
      <defs>
        <pattern id="grid" width="26" height="26" patternUnits="userSpaceOnUse">
          <path d="M26 0H0V26" fill="none" stroke="#18242d" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#grid)" />
      {lanes.map((l) => (
        <line
          key={l.a + l.b}
          x1={px(CITIES[l.a].lon)}
          y1={py(CITIES[l.a].lat)}
          x2={px(CITIES[l.b].lon)}
          y2={py(CITIES[l.b].lat)}
          stroke={l.g === 'deccan' ? '#24506a' : '#3d3a66'}
          strokeWidth={2}
          strokeLinecap="round"
        />
      ))}
      {cities.map((c) => (
        <g key={c}>
          <circle cx={px(CITIES[c].lon)} cy={py(CITIES[c].lat)} r={3} fill="#3a4b58" />
          <text x={px(CITIES[c].lon) + 6} y={py(CITIES[c].lat) - 6} fontSize="10.5" fill="#7c8d9b">
            {c}
          </text>
        </g>
      ))}
      {plotted.map((d) => {
        const st = states.get(d.id);
        const sk = statusKey(st);
        const color = STATUS_META[sk].dot;
        const a = CITIES[d.origin];
        const b = CITIES[d.destination] ?? a;
        const p = d.kind === 'shipment' ? (st?.progress ?? 0) : 0;
        const x = px(a.lon + (b.lon - a.lon) * p);
        const y = py(a.lat + (b.lat - a.lat) * p);
        const hl = highlight === d.id;
        const label = `${d.id} ${d.name}: ${STATUS_META[sk].label}, ${fmtTemp(st?.tc)}`;
        return (
          <g
            key={d.id}
            role="link"
            tabIndex={0}
            aria-label={label}
            className="cursor-pointer"
            onClick={() => nav(`/device/${d.id}`)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && nav(`/device/${d.id}`)}
          >
            <title>{label}</title>
            {sk === 'critical' && (
              <circle cx={x} cy={y} r={11} fill="none" stroke={color} strokeOpacity={0.6}>
                <animate attributeName="r" values="7;15;7" dur="1.6s" repeatCount="indefinite" />
                <animate attributeName="stroke-opacity" values="0.7;0;0.7" dur="1.6s" repeatCount="indefinite" />
              </circle>
            )}
            {d.kind === 'facility' ? (
              <rect x={x - 6 + 10} y={y - 6 + 10} width={12} height={12} rx={2} fill={color} stroke={hl ? '#fff' : '#0b1116'} strokeWidth={hl ? 2 : 1.5} />
            ) : (
              <circle cx={x} cy={y} r={hl ? 7 : 5.5} fill={color} stroke={hl ? '#fff' : '#0b1116'} strokeWidth={hl ? 2 : 1.5} />
            )}
          </g>
        );
      })}
    </svg>
  );
});
