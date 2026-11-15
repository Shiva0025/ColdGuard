import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { INCIDENT_LABEL, type IncidentType } from '@coldguard/shared';
import { api } from '../lib/api';
import { incidents, useStore } from '../lib/stores';
import { fmtDuration } from '../lib/format';

interface Summary {
  total: number;
  critical: number;
  active: number;
  unacknowledged: number;
  acknowledged: number;
  resolved: number;
  medianAckSec: number | null;
  medianResolveSec: number | null;
}
interface Analytics {
  hours: number;
  generatedAt: number;
  truncated: boolean;
  overall: Summary;
  byType: (Summary & { key: string })[];
  byGroup: (Summary & { key: string })[];
  topDevices: (Summary & { key: string })[];
}

const WINDOWS = [
  { h: 1, label: '1 h' },
  { h: 24, label: '24 h' },
  { h: 72, label: '72 h' },
];

/** How quickly incidents were acknowledged and resolved, computed by the server from stored incidents. */
export function ResponseStats() {
  useStore(incidents);
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<Analytics | null>(null);
  const [failed, setFailed] = useState(false);
  // Refetch when the window changes or the set of incidents / their states changes (not on every store tick).
  const signature = incidents
    .all()
    .slice(0, 50)
    .map((i) => `${i.id}${i.state[0]}`)
    .join(',');

  useEffect(() => {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      api<Analytics>(`/analytics/incidents?hours=${hours}`, { signal: ac.signal })
        .then((d) => {
          setData(d);
          setFailed(false);
        })
        .catch((e) => e?.name !== 'AbortError' && setFailed(true));
    }, 400);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [hours, signature]);

  const o = data?.overall;
  return (
    <section className="panel p-3" aria-labelledby="resp-h">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="resp-h" className="flex items-center gap-1.5 text-sm font-semibold">
          <Timer size={15} aria-hidden /> Response performance
        </h2>
        <span className="text-[11px] text-ink-3">medians from stored incidents in your corridors</span>
        <div className="ml-auto flex gap-1" role="group" aria-label="Window">
          {WINDOWS.map((w) => (
            <button key={w.h} aria-pressed={hours === w.h} className={`btn btn-sm ${hours === w.h ? 'border-ice text-ice' : 'text-ink-3'}`} onClick={() => setHours(w.h)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>
      {failed && !data ? (
        <p className="mt-2 text-xs text-crit">Could not load response statistics.</p>
      ) : !o ? (
        <p className="mt-2 text-xs text-ink-3">Loading…</p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Incidents" value={String(o.total)} sub={`${o.critical} critical`} />
            <Stat label="Waiting for ack" value={String(o.unacknowledged)} sub={`${o.active} still active`} tone={o.unacknowledged > 0 ? 'text-crit' : ''} />
            <Stat label="Time to acknowledge" value={fmtDuration(o.medianAckSec)} sub={`median of ${o.acknowledged} acknowledged`} />
            <Stat label="Time to resolve" value={fmtDuration(o.medianResolveSec)} sub={`median of ${o.resolved} resolved`} />
            <Stat
              label="Most incidents"
              value={data!.topDevices[0]?.key ?? '—'}
              sub={data!.topDevices[0] ? `${data!.topDevices[0].total} in window` : 'none in window'}
            />
          </div>
          {data!.byType.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-xs">
                <thead className="text-ink-3">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Rule</th>
                    <th className="py-1 pr-3 text-right font-medium">Count</th>
                    <th className="py-1 pr-3 text-right font-medium">Active</th>
                    <th className="py-1 pr-3 text-right font-medium">Median to ack</th>
                    <th className="py-1 text-right font-medium">Median to resolve</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.byType.map((t) => (
                    <tr key={t.key} className="border-t border-line">
                      <td className="py-1 pr-3">{INCIDENT_LABEL[t.key as IncidentType] ?? t.key}</td>
                      <td className="tabular py-1 pr-3 text-right">{t.total}</td>
                      <td className="tabular py-1 pr-3 text-right">{t.active}</td>
                      <td className="tabular py-1 pr-3 text-right">{fmtDuration(t.medianAckSec)}</td>
                      <td className="tabular py-1 text-right">{fmtDuration(t.medianResolveSec)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data!.truncated && <p className="mt-2 text-[11px] text-warn">Based on the most recent 5,000 incidents in this window.</p>}
        </>
      )}
    </section>
  );
}

function Stat({ label, value, sub, tone = '' }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className={`tabular truncate text-lg font-semibold ${tone}`}>{value}</div>
      <div className="truncate text-[11px] text-ink-3">{sub}</div>
    </div>
  );
}
