import { useState } from 'react';
import { Link } from 'react-router';
import { CheckCheck, ChevronDown, ChevronUp, FileCheck2, History } from 'lucide-react';
import { INCIDENT_LABEL, type Incident } from '@coldguard/shared';
import { api } from '../lib/api';
import { incidents } from '../lib/stores';
import { fleet } from '../lib/stores';
import { fmtDateTime, fmtTime } from '../lib/format';

export function IncidentStateBadge({ i }: { i: Incident }) {
  if (i.state === 'resolved')
    return <span className="rounded-full bg-ok-bg px-2 py-0.5 text-[11px] font-semibold text-ok">Resolved{!i.ack ? ' · unacknowledged' : ''}</span>;
  if (i.state === 'acknowledged') return <span className="rounded-full bg-ice-dim/50 px-2 py-0.5 text-[11px] font-semibold text-ice">Acknowledged</span>;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${i.severity === 'critical' ? 'bg-crit-bg text-crit' : 'bg-warn-bg text-warn'}`}>
      {i.severity === 'critical' ? 'Critical · open' : 'Warning · open'}
    </span>
  );
}

export function IncidentCard({ i, canAck, compact = false, showDevice = true }: { i: Incident; canAck: boolean; compact?: boolean; showDevice?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dev = fleet.devices.get(i.deviceId);

  async function ack() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ incident: Incident }>(`/incidents/${encodeURIComponent(i.id)}/ack`, { method: 'POST', json: note ? { note } : {} });
      incidents.upsert(r.incident);
      setNote('');
    } catch (e: any) {
      setErr(e?.message ?? 'failed');
    } finally {
      setBusy(false);
    }
  }

  const border = !i.active ? 'border-l-ok/60' : i.severity === 'critical' ? 'border-l-crit' : 'border-l-warn';
  return (
    <article className={`rounded-lg border border-line border-l-4 ${border} bg-panel-2/60 p-3`} aria-label={`${INCIDENT_LABEL[i.type]} on ${i.deviceId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{INCIDENT_LABEL[i.type]}</span>
        <IncidentStateBadge i={i} />
        <span className="ml-auto text-[11px] text-ink-3 tabular">{fmtDateTime(i.triggeredAt)}</span>
      </div>
      {showDevice && (
        <Link to={`/device/${i.deviceId}`} className="mt-1 block text-xs text-ice hover:underline">
          {i.deviceId} · {dev?.name ?? ''}
        </Link>
      )}
      <p className={`mt-2 text-[13px] leading-snug text-ink-2 ${open ? '' : 'line-clamp-2'}`}>{i.explanation}</p>
      {open && (
        <>
          {(i.evidence.first || i.evidence.peak) && (
            <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
              {i.evidence.first && (
                <div>
                  <dt className="text-ink-3">First reading</dt>
                  <dd className="tabular">
                    {i.evidence.first.tc.toFixed(1)} °C · {fmtTime(i.evidence.first.t)}
                  </dd>
                </div>
              )}
              {i.evidence.trigger && (
                <div>
                  <dt className="text-ink-3">Trigger reading</dt>
                  <dd className="tabular">
                    {i.evidence.trigger.tc.toFixed(1)} °C · {fmtTime(i.evidence.trigger.t)}
                  </dd>
                </div>
              )}
              {i.evidence.peak && (
                <div>
                  <dt className="text-ink-3">Peak</dt>
                  <dd className="tabular">
                    {i.evidence.peak.tc.toFixed(1)} °C · {fmtTime(i.evidence.peak.t)}
                  </dd>
                </div>
              )}
            </dl>
          )}
          <ol className="mt-3 space-y-1.5 border-l border-line-2 pl-3">
            {i.timeline.map((e, k) => (
              <li key={k} className="relative text-[12px] text-ink-2">
                <span className="absolute top-1.5 -left-[16px] h-2 w-2 rounded-full bg-line-2" />
                <span className="font-semibold text-ink tabular">{fmtTime(e.at)}</span> <span className="text-ink-3">{e.kind}</span>
                {e.by && <span className="text-ice"> · {e.by}</span>}
                {e.kind !== 'opened' && <div className="text-ink-2">{e.text}</div>}
              </li>
            ))}
          </ol>
        </>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {compact && (
          <button className="btn btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />} {open ? 'Less' : 'Evidence & timeline'}
          </button>
        )}
        {(i.type === 'temp_high' || i.type === 'temp_low' || i.type === 'rapid_drift' || i.type === 'exposure_budget') && (
          <Link to={`/incident/${encodeURIComponent(i.id)}/replay`} className="btn btn-sm">
            <History size={13} aria-hidden /> Replay incident
          </Link>
        )}
        {(i.type === 'temp_high' || i.type === 'temp_low' || i.type === 'exposure_budget') && (
          <Link to={`/incident/${encodeURIComponent(i.id)}/report`} className="btn btn-sm">
            <FileCheck2 size={13} aria-hidden /> Evidence report
          </Link>
        )}
        {i.ack ? (
          <span className="text-[11px] text-ice">
            <CheckCheck size={12} className="mr-1 inline" aria-hidden />
            Acknowledged by <b>{i.ack.by}</b> at {fmtTime(i.ack.at)}
            {i.ack.note ? ` — “${i.ack.note}”` : ''}
          </span>
        ) : canAck ? (
          <form
            className="flex flex-1 flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void ack();
            }}
          >
            <input
              className="input min-w-0 flex-1 py-1 text-xs"
              placeholder="Note (optional) e.g. driver contacted, moved to backup reefer"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              aria-label="Acknowledgement note"
            />
            <button className="btn btn-sm btn-primary" disabled={busy}>
              <CheckCheck size={13} aria-hidden /> {busy ? 'Saving…' : 'Acknowledge'}
            </button>
          </form>
        ) : (
          <span className="text-[11px] text-ink-3">Viewer role · operators acknowledge</span>
        )}
        {err && <span className="text-[11px] text-crit">{err}</span>}
      </div>
    </article>
  );
}
