import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import QRCode from 'qrcode';
import { QrCode, RefreshCw, Smartphone, Users, XCircle } from 'lucide-react';
import type { DeviceState } from '@coldguard/shared';
import { api } from '../lib/api';
import { fleet } from '../lib/stores';
import { fmtTemp } from '../lib/format';
import { StatusBadge, statusKey } from './bits';

interface Invite {
  code: string;
  expiresAt: number;
  maxClaims: number;
}
interface Status {
  invite: Invite | null;
  lanAddresses: string[];
  trucks: { deviceId: string; name: string; claimedAt: number; state?: DeviceState }[];
}

/** Operator panel: create a QR invite so audience phones become trucks in the `guest` group. */
export function JudgesPanel({ big = false }: { big?: boolean }) {
  const [st, setSt] = useState<Status | null>(null);
  const [base, setBase] = useState<string>('');
  const [svg, setSvg] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const load = () =>
    api<Status>('/guest/status')
      .then(setSt)
      .catch((e) => setErr(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  // Phones cannot reach "localhost": offer the machine's LAN addresses with the current port.
  const bases = useMemo(() => {
    const here = window.location;
    const out = [here.origin];
    if (/^(localhost|127\.)/.test(here.hostname)) for (const ip of st?.lanAddresses ?? []) out.unshift(`${here.protocol}//${ip}${here.port ? `:${here.port}` : ''}`);
    return [...new Set(out)];
  }, [st?.lanAddresses]);
  useEffect(() => {
    if (!base && bases.length) setBase(bases[0]);
  }, [bases, base]);

  const url = st?.invite && base ? `${base}/join/${st.invite.code}` : '';
  useEffect(() => {
    if (!url) return setSvg('');
    QRCode.toDataURL(url, { margin: 1, width: 480, errorCorrectionLevel: 'M', color: { dark: '#0b1116', light: '#ffffff' } })
      .then(setSvg)
      .catch(() => setSvg(''));
  }, [url]);

  async function create() {
    setErr(null);
    try {
      await api('/guest/invite', { method: 'POST', json: { ttlMin: 60 } });
      await load();
      if (!fleet.selectedGroups.includes('guest')) void fleet.load([...fleet.selectedGroups, 'guest']);
    } catch (e: any) {
      setErr(e.message);
    }
  }
  async function release() {
    if (!confirm('Release all judge trucks and invalidate the invite?')) return;
    await api('/guest/release', { method: 'POST' });
    await load();
  }

  const mins = st?.invite ? Math.max(0, Math.round((st.invite.expiresAt - Date.now()) / 60000)) : 0;
  return (
    <section className="panel p-4" aria-labelledby="judges-h">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="judges-h" className="flex items-center gap-1.5 text-sm font-semibold">
          <Smartphone size={16} className="text-ice" aria-hidden /> Judges join by QR
        </h2>
        <span className="text-xs text-ink-3">Each phone becomes a truck that streams through the real ingest API.</span>
        <div className="ml-auto flex gap-2">
          <button className="btn btn-sm btn-primary" onClick={create}>
            {st?.invite ? <RefreshCw size={13} /> : <QrCode size={13} />} {st?.invite ? 'New code' : 'Create invite'}
          </button>
          {!!st?.trucks.length && (
            <button className="btn btn-sm" onClick={release}>
              <XCircle size={13} /> Release trucks
            </button>
          )}
        </div>
      </div>
      {err && <p className="mt-2 text-xs text-crit">{err}</p>}
      <div className={`mt-3 grid gap-4 ${big ? 'md:grid-cols-[320px_1fr]' : 'md:grid-cols-[220px_1fr]'}`}>
        <div>
          {url ? (
            <>
              {svg && <img src={svg} alt={`QR code for ${url}`} className="w-full rounded-lg bg-white p-2" />}
              <div className="mt-2 text-center text-xs break-all text-ink-2">{url}</div>
              <div className="mt-1 text-center text-[11px] text-ink-3">
                code <b className="text-ink tabular">{st!.invite!.code}</b> · expires in {mins} min · max {st!.invite!.maxClaims} trucks
              </div>
              {bases.length > 1 && (
                <label className="mt-2 block text-[11px] text-ink-3">
                  Address phones should use
                  <select className="input mt-1 w-full py-1" value={base} onChange={(e) => setBase(e.target.value)}>
                    {bases.map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </select>
                </label>
              )}
            </>
          ) : (
            <div className="flex aspect-square flex-col items-center justify-center rounded-lg border border-dashed border-line-2 text-center text-xs text-ink-3">
              <QrCode size={28} aria-hidden />
              <span className="mt-1 px-4">Create an invite, then show this QR code on the projector.</span>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="label flex items-center gap-1">
            <Users size={12} aria-hidden /> Trucks on the road ({st?.trucks.length ?? 0})
          </div>
          {st?.trucks.length ? (
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {st.trucks.map((t) => {
                const s = fleet.states.get(t.deviceId) ?? t.state;
                return (
                  <li key={t.deviceId}>
                    <Link to={`/device/${t.deviceId}`} className="flex items-center gap-2 rounded-md border border-line bg-panel-2 px-2.5 py-2 hover:border-line-2">
                      <StatusBadge status={statusKey(s)} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t.name}</span>
                      <span className="text-sm tabular">{fmtTemp(s?.tc)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-ink-3">
              No phones yet. Phones must reach this machine: run the stack on the venue Wi-Fi (Vite listens on all interfaces) or deploy it.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
