import { useEffect, useState } from 'react';
import { Copy, Radio, Shuffle, Unplug, Zap } from 'lucide-react';
import type { SimDeviceNet } from '@coldguard/shared';
import { api } from '../lib/api';
import { realtime } from '../lib/realtime';
import { fmtInt, fmtTime } from '../lib/format';
import type { DeviceStream } from '../lib/deviceStream';

interface Integrity {
  deviceId: string;
  serverTime: number;
  persisted: number;
  lateStored: number;
  duplicatesRejectedSinceStart: number;
  backfilledSinceStart: number;
  statusBasis: { position: { sessionId: string; seq: number; observedAt: number } | null; observedAt: number | null; receivedAt: number | null; status: string | null };
  pendingCommands: number;
  uplink: SimDeviceNet | null;
  simulatorConnected: boolean;
}

/**
 * "Break the network" for one truck: operator-controlled failures (real simulator
 * faults on the real ingest path) next to ACTUAL counts from MongoDB, the ingest
 * pipeline, the simulator's uplink and this tab's merge buffer.
 */
export function NetworkPanel({ deviceId, stream, canBreak }: { deviceId: string; stream: DeviceStream; canBreak: boolean }) {
  const [d, setD] = useState<Integrity | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Integrity>(`/devices/${encodeURIComponent(deviceId)}/integrity`)
        .then((x) => alive && setD(x))
        .catch(() => {});
    void load();
    const t = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [deviceId]);

  async function fault(kind: string, durationSec?: number) {
    try {
      await api('/sim/fault', { method: 'POST', json: { kind, deviceId, ...(durationSec ? { durationSec } : {}) } });
      setMsg(
        kind === 'sensor_dropout'
          ? 'Signal cut — the truck keeps measuring and buffers readings'
          : kind === 'reconnect'
            ? 'Signal restored — buffered readings are being delivered'
            : `${kind.replace('_', ' ')} for 20 s`,
      );
    } catch (e: any) {
      setMsg(e.message);
    }
  }

  const u = d?.uplink;
  const offline = !!u?.offline;
  const awaiting = (u?.buffered ?? 0) + (u?.outbox ?? 0) + (u?.heldOutOfOrder ?? 0);
  const bfTotal = u?.backfillTotal ?? 0;
  const bfDone = u?.backfillDelivered ?? 0;
  const now = Date.now() + realtime.clockOffset;
  const age = d?.statusBasis.observedAt ? Math.max(0, (now - d.statusBasis.observedAt) / 1000) : null;
  const chartIds = stream.window.size;
  const chartDupes = chartIds - new Set(stream.window.items.map((r) => r.id)).size; // verified, not assumed

  const Row = ({ k, v, hint, tone }: { k: string; v: React.ReactNode; hint: string; tone?: string }) => (
    <div className="flex items-baseline gap-2 px-1 py-1.5" title={hint}>
      <dt className="text-ink-2">{k}</dt>
      <dd className={`ml-auto font-semibold tabular ${tone ?? ''}`}>{v}</dd>
    </div>
  );

  return (
    <section className="panel p-3" aria-labelledby="net-h">
      <div className="flex items-center gap-2 px-1">
        <h2 id="net-h" className="text-sm font-semibold">
          Break the network
        </h2>
        <span className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${offline ? 'bg-warn-bg text-warn' : 'bg-ok-bg text-ok'}`}>
          {offline ? <Unplug size={11} /> : <Radio size={11} />} {offline ? 'Truck offline · buffering' : 'Truck uplink online'}
        </span>
      </div>
      {canBreak && (
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {offline ? (
            <button className="btn btn-sm btn-primary justify-center" onClick={() => fault('reconnect')}>
              <Zap size={13} /> Restore signal
            </button>
          ) : (
            <button className="btn btn-sm justify-center" onClick={() => fault('sensor_dropout')}>
              <Unplug size={13} /> Cut signal
            </button>
          )}
          <button className="btn btn-sm justify-center" onClick={() => fault('out_of_order', 20)}>
            <Shuffle size={13} /> Delay + reorder
          </button>
          <button className="btn btn-sm col-span-2 justify-center" onClick={() => fault('duplicates', 20)}>
            <Copy size={13} /> Duplicate deliveries (20 s)
          </button>
        </div>
      )}
      {msg && <div className="mt-1.5 px-1 text-[11px] text-ink-2">{msg}</div>}

      {bfTotal > 0 && (
        <div className="mt-2 px-1">
          <div className="flex text-[11px] text-ink-2">
            Reconnect catch-up <span className="ml-auto tabular">{fmtInt(bfDone)} / {fmtInt(bfTotal)} buffered readings stored</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-line">
            <div className="h-1.5 rounded-full bg-ice transition-all" style={{ width: `${Math.min(100, (bfDone / bfTotal) * 100)}%` }} />
          </div>
        </div>
      )}

      <dl className="mt-2 divide-y divide-line/70 text-xs">
        <Row k="Unique events persisted" v={d ? fmtInt(d.persisted) : '—'} hint="MongoDB count for this logger (unique _id = eventId)" />
        <Row k="Duplicates rejected" v={d ? fmtInt(d.duplicatesRejectedSinceStart) : '—'} hint="Rejected by the unique index since server start" tone={d?.duplicatesRejectedSinceStart ? 'text-ice' : ''} />
        <Row k="Late / out-of-order stored" v={d ? fmtInt(d.lateStored) : '—'} hint="Stored and shown in history; never changed current status" />
        <Row k="Backfilled after reconnect" v={d ? fmtInt(d.backfilledSinceStart) : '—'} hint="Delivered ≥ 10 s after observation (store-and-forward), since server start" />
        <Row
          k="Awaiting delivery"
          v={u ? `${fmtInt(awaiting)}${u.buffered ? ` (${fmtInt(u.buffered)} on truck)` : ''}` : '0'}
          hint="On the truck + in its uplink + held back by the delay fault"
          tone={awaiting > 0 ? 'text-warn' : ''}
        />
        <Row k="Commands waiting for signal" v={d ? d.pendingCommands : '—'} hint="Operator commands queued until the truck reconnects" tone={d?.pendingCommands ? 'text-warn' : ''} />
        <Row
          k="Latest reading age"
          v={age == null ? '—' : `${age < 2 ? '<2' : Math.round(age)} s`}
          hint="Device time of the reading the current status is based on"
          tone={age != null && age > 15 ? 'text-warn' : ''}
        />
        <Row
          k="Status based on"
          v={d?.statusBasis.position ? `seq ${d.statusBasis.position.seq} · ${fmtTime(d.statusBasis.position.observedAt)}` : '—'}
          hint="Newest in-order reading; a stale arrival can never replace it"
        />
        <Row k="Chart points / duplicates" v={`${fmtInt(chartIds)} / ${chartDupes}`} hint="Counted in this tab: points in the chart buffer and how many share an eventId" />
      </dl>
      {!d?.simulatorConnected && <p className="mt-1 px-1 text-[11px] text-warn">Simulator not connected — failures cannot be injected.</p>}
    </section>
  );
}
