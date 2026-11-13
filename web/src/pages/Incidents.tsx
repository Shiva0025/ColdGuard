import { useState } from 'react';
import { BellOff } from 'lucide-react';
import { INCIDENT_LABEL, type IncidentType } from '@coldguard/shared';
import { incidents, useStore } from '../lib/stores';
import type { SessionUser } from '../lib/api';
import { Empty } from '../components/bits';
import { IncidentCard } from '../components/IncidentCard';

type Scope = 'open' | 'unacked' | 'resolved' | 'all';

export function IncidentsPage({ user }: { user: SessionUser }) {
  useStore(incidents);
  const [scope, setScope] = useState<Scope>('open');
  const [type, setType] = useState<IncidentType | 'any'>('any');
  const list = incidents
    .all()
    .filter((i) => (scope === 'open' ? i.active : scope === 'unacked' ? !i.ack : scope === 'resolved' ? !i.active : true))
    .filter((i) => type === 'any' || i.type === type);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl font-semibold">Incidents</h1>
        <div className="flex gap-1" role="group" aria-label="Scope">
          {(['open', 'unacked', 'resolved', 'all'] as Scope[]).map((s) => (
            <button key={s} aria-pressed={scope === s} className={`btn btn-sm ${scope === s ? 'border-ice text-ice' : 'text-ink-3'}`} onClick={() => setScope(s)}>
              {s === 'unacked' ? 'Unacknowledged' : s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2 text-xs text-ink-3">
          Type
          <select className="input py-1" value={type} onChange={(e) => setType(e.target.value as IncidentType | 'any')}>
            <option value="any">Any</option>
            {Object.entries(INCIDENT_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-ink-3">
        One active incident per logger and rule (deduplicated in memory and by a partial unique index in MongoDB). Excursions resolve only after the
        temperature stays inside the hysteresis band for the configured recovery time, so alerts do not flicker.
      </p>
      {incidents.loading ? (
        <div className="text-sm text-ink-3">Loading…</div>
      ) : list.length === 0 ? (
        <Empty icon={BellOff} title="Nothing here">No incidents match this filter in your corridors.</Empty>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {list.slice(0, 100).map((i) => (
            <IncidentCard key={i.id} i={i} canAck={user.role === 'operator'} compact />
          ))}
        </div>
      )}
    </div>
  );
}
