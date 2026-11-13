import { useEffect, useState } from 'react';
import { Fingerprint, Loader2, ShieldAlert, ShieldCheck, Undo2, Skull } from 'lucide-react';
import { api } from '../lib/api';
import { fmtInt, fmtTime } from '../lib/format';

interface Verify {
  ok: boolean;
  blocksChecked: number;
  readingsChecked: number;
  totalBlocks: number;
  head: string | null;
  unsealedTail: number;
  verifiedAt: number;
  firstBreak?: { block: number; reason: string; eventId?: string; detail: string };
  tamperedDemo: { eventId: string; original: number; altered: number } | null;
}

/** Re-verifies this truck's hash chain against what MongoDB currently stores. */
export function EvidencePanel({ deviceId, canDemo }: { deviceId: string; canDemo: boolean }) {
  const [v, setV] = useState<Verify | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [resetAllowed, setResetAllowed] = useState(false);

  const verify = async () => {
    setBusy(true);
    setErr(null);
    try {
      setV(await api<Verify>(`/devices/${encodeURIComponent(deviceId)}/evidence`));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void verify();
    if (canDemo) api<{ resetAllowed: boolean }>('/sim').then((s) => setResetAllowed(s.resetAllowed)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  async function tamper(undo: boolean) {
    setErr(null);
    try {
      await api('/demo/tamper', { method: 'POST', json: { deviceId, ...(undo ? { undo: true } : {}) } });
      await verify();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <section className="panel p-3" aria-labelledby="ev-h">
      <div className="flex items-center gap-2 px-1">
        <h2 id="ev-h" className="flex items-center gap-1.5 text-sm font-semibold">
          <Fingerprint size={15} className="text-ice" aria-hidden /> Evidence chain
        </h2>
        <button className="btn btn-sm ml-auto" onClick={verify} disabled={busy}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Verify now
        </button>
      </div>
      {v && (
        <div className={`mt-2 rounded-lg border p-2.5 ${v.ok ? 'border-ok/40 bg-ok-bg/40' : 'border-crit/60 bg-crit-bg/60'}`} role="status">
          <div className={`flex items-center gap-1.5 text-sm font-semibold ${v.ok ? 'text-ok' : 'text-crit'}`}>
            {v.ok ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
            {v.ok ? 'Intact — every stored reading matches its seal' : `Chain broken at block #${v.firstBreak?.block}: ${v.firstBreak?.reason}`}
          </div>
          {!v.ok && <div className="mt-1 text-xs text-ink-2">{v.firstBreak?.detail}</div>}
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px]">
            <dt className="text-ink-3">Blocks checked</dt>
            <dd className="text-right tabular">
              {fmtInt(v.blocksChecked)} / {fmtInt(Math.min(500, v.totalBlocks))}
            </dd>
            <dt className="text-ink-3">Readings checked</dt>
            <dd className="text-right tabular">{fmtInt(v.readingsChecked)}</dd>
            <dt className="text-ink-3">Not yet sealed</dt>
            <dd className="text-right tabular">{fmtInt(v.unsealedTail)}</dd>
            <dt className="text-ink-3">Chain head</dt>
            <dd className="truncate text-right font-mono text-[10.5px]">{v.head ? `${v.head.slice(0, 16)}…` : '—'}</dd>
            <dt className="text-ink-3">Verified at</dt>
            <dd className="text-right tabular">{fmtTime(v.verifiedAt)}</dd>
          </dl>
        </div>
      )}
      <p className="mt-2 px-1 text-[11px] leading-snug text-ink-3">
        Readings are sealed in commit order into SHA-256 blocks (≤ 60 readings or 10 s), each linked to the previous one. Editing, deleting or inserting
        a stored reading breaks the chain at that exact reading.
      </p>
      {canDemo && resetAllowed && (
        <div className="mt-2 flex flex-wrap gap-2 px-1">
          {v?.tamperedDemo ? (
            <button className="btn btn-sm" onClick={() => tamper(true)}>
              <Undo2 size={13} /> Undo tamper ({v.tamperedDemo.eventId.split(':').pop()})
            </button>
          ) : (
            <button className="btn btn-sm btn-danger" onClick={() => tamper(false)} title="Demo only: lowers the hottest sealed reading by 3 °C directly in MongoDB, as an insider hiding an excursion would">
              <Skull size={13} /> Tamper with a stored reading (demo)
            </button>
          )}
        </div>
      )}
      {err && <p className="mt-1 px-1 text-xs text-crit">{err}</p>}
    </section>
  );
}
