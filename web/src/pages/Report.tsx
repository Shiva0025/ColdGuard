import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Download, Printer, ShieldAlert, ShieldCheck } from 'lucide-react';
import { INCIDENT_LABEL, excessDegMin, type DeviceInfo, type Incident, type Reading, type Rules } from '@coldguard/shared';
import { api } from '../lib/api';
import { COOLING_LABEL, fmtDateTime, fmtInt, fmtTime } from '../lib/format';
import { Empty } from '../components/bits';

interface Report {
  format: string;
  generatedAt: number;
  generatedBy: string;
  disclaimer: string;
  incident: Incident;
  device: DeviceInfo;
  rules: Rules;
  window: { from: number; to: number };
  chain: { prevHashOfFirstBlock: string | null; blocks: { n: number; hash: string; count: number }[]; unsealedReadingsInWindow: number };
  readings: Reading[];
  verification: { ok: boolean; blocksChecked: number; readingsChecked: number; firstBreak?: { block: number; reason: string; detail: string } };
  howToVerify: string;
}

/** Printable, self-verifiable excursion report. */
export function ReportPage() {
  const { id = '' } = useParams();
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<Report>(`/incidents/${encodeURIComponent(id)}/report`)
      .then(setRep)
      .catch((e) => setErr(e.message));
  }, [id]);
  if (err) return <Empty title="Report unavailable">{err}</Empty>;
  if (!rep) return <div className="p-6 text-sm text-ink-3">Building report and verifying the evidence chain…</div>;

  const inc = rep.incident;
  const R = rep.rules;
  const inWin = rep.readings.filter((r) => r.t >= rep.window.from && r.t <= rep.window.to).sort((a, b) => a.t - b.t);
  const out = inWin.filter((r) => r.tc > R.tempHighC || r.tc < R.tempLowC);
  let exposure = 0;
  for (let i = 1; i < inWin.length; i++) exposure += excessDegMin(inWin[i - 1], inWin[i], R.tempLowC, R.tempHighC);
  const peak = inWin.reduce<Reading | null>((a, b) => (!a || b.tc > a.tc ? b : a), null);
  const step = Math.max(1, Math.ceil(inWin.length / 40));
  const sample = inWin.filter((_, i) => i % step === 0).slice(0, 80);
  const download = () => {
    const blob = new Blob([JSON.stringify(rep, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `coldguard-report-${inc.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const v = rep.verification;

  return (
    <div className="report mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Link to={`/device/${inc.deviceId}`} className="btn btn-sm">
          <ArrowLeft size={14} /> {inc.deviceId}
        </Link>
        <button className="btn btn-sm ml-auto" onClick={() => window.print()}>
          <Printer size={14} /> Print / save PDF
        </button>
        <button className="btn btn-sm btn-primary" onClick={download}>
          <Download size={14} /> Download evidence JSON
        </button>
      </div>

      <section className="panel p-5">
        <div className="label">ColdGuard excursion report · simulated data</div>
        <h1 className="mt-1 text-2xl font-semibold">
          {INCIDENT_LABEL[inc.type]} — {rep.device?.name} <span className="text-ink-3">({inc.deviceId})</span>
        </h1>
        <p className="mt-2 text-sm text-ink-2">{inc.explanation}</p>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Item k="Alert raised" v={fmtDateTime(inc.triggeredAt)} />
          <Item k="Resolved" v={inc.resolvedAt ? fmtDateTime(inc.resolvedAt) : 'still open'} />
          <Item k="Peak" v={peak ? `${peak.tc.toFixed(2)} °C at ${fmtTime(peak.t)}` : '—'} />
          <Item k="Readings out of range" v={`${out.length} of ${inWin.length}`} />
          <Item k="Heat exposure in window" v={`${exposure.toFixed(1)} °C·min (budget ${R.exposureBudgetCMin}, demo)`} />
          <Item k="Demo limits" v={`${R.tempLowC}–${R.tempHighC} °C, sustained ${R.sustainSec} s`} />
          <Item k="Acknowledged" v={inc.ack ? `${inc.ack.by} at ${fmtTime(inc.ack.at)}` : 'no'} />
          <Item k="Product" v={`${rep.device?.product} · ${fmtInt(rep.device?.simulatedDoses ?? 0)} doses (sim)`} />
        </dl>
      </section>

      <section className={`panel p-5 ${v.ok ? 'border-ok/50' : 'border-crit/60'}`}>
        <div className={`flex items-center gap-2 text-base font-semibold ${v.ok ? 'text-ok' : 'text-crit'}`}>
          {v.ok ? <ShieldCheck size={20} /> : <ShieldAlert size={20} />}
          {v.ok ? 'Evidence verified: stored readings match their sealed hashes' : `Evidence FAILED verification at block #${v.firstBreak?.block}: ${v.firstBreak?.reason}`}
        </div>
        <p className="mt-1 text-sm text-ink-2">
          {fmtInt(v.readingsChecked)} readings in {v.blocksChecked} hash-linked blocks (#{rep.chain.blocks[0]?.n}…#{rep.chain.blocks[rep.chain.blocks.length - 1]?.n}). Chain head{' '}
          <code className="text-xs">{rep.chain.blocks[rep.chain.blocks.length - 1]?.hash.slice(0, 24)}…</code>
          {rep.chain.unsealedReadingsInWindow > 0 && ` · ${rep.chain.unsealedReadingsInWindow} reading(s) not yet sealed and not covered.`}
        </p>
        <p className="mt-2 text-xs text-ink-3">
          Independent check: download the JSON and run <code>npm run verify-report -- coldguard-report-{inc.id}.json</code>. It recomputes every hash from the file
          alone; changing any value in it makes verification fail.
        </p>
      </section>

      <section className="panel p-5">
        <h2 className="text-sm font-semibold">Timeline</h2>
        <ol className="mt-2 space-y-1 text-sm">
          {inc.timeline.map((e, i) => (
            <li key={i}>
              <b className="tabular">{fmtTime(e.at)}</b> <span className="text-ink-3">{e.kind}</span> {e.by && <span className="text-ice">· {e.by}</span>} — <span className="text-ink-2">{e.text}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel p-5">
        <h2 className="text-sm font-semibold">Readings (sample of {sample.length}; all {fmtInt(rep.readings.length)} sealed readings are in the JSON)</h2>
        <table className="mt-2 w-full text-left text-xs tabular">
          <thead className="text-ink-3">
            <tr>
              <th className="py-1">Observed</th>
              <th>Temp</th>
              <th>RH</th>
              <th>Door</th>
              <th>Cooling</th>
              <th>Event id</th>
            </tr>
          </thead>
          <tbody>
            {sample.map((r) => (
              <tr key={r.id} className={`border-t border-line/60 ${r.tc > R.tempHighC || r.tc < R.tempLowC ? 'text-crit' : ''}`}>
                <td className="py-0.5">{fmtTime(r.t)}</td>
                <td>{r.tc.toFixed(2)} °C</td>
                <td>{r.h.toFixed(0)} %</td>
                <td>{r.door === 1 ? 'open' : r.door === 0 ? 'closed' : '—'}</td>
                <td>{COOLING_LABEL[r.cs]}</td>
                <td className="font-mono text-[10.5px] text-ink-3">{r.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="text-center text-[11px] text-ink-3">
        Generated {fmtDateTime(rep.generatedAt)} by {rep.generatedBy}. {rep.disclaimer}
      </p>
    </div>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="label">{k}</dt>
      <dd className="mt-0.5">{v}</dd>
    </div>
  );
}
