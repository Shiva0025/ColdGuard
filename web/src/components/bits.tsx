import { memo, useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Flame, Loader2, PauseCircle, RefreshCw, WifiOff, Radio, Hourglass } from 'lucide-react';
import type { DeviceState } from '@coldguard/shared';
import { STATUS_META } from '../lib/format';
import type { StreamPhase } from '../lib/deviceStream';

export type StatusKey = DeviceState['status'] | 'nodata';

export function statusKey(s: DeviceState | undefined): StatusKey {
  if (!s || s.t == null) return 'nodata';
  return s.status;
}

const STATUS_ICON: Record<StatusKey, typeof CheckCircle2> = {
  healthy: CheckCircle2,
  warning: AlertTriangle,
  critical: Flame,
  offline: WifiOff,
  nodata: CircleSlash,
};

export function StatusBadge({ status, size = 'md' }: { status: StatusKey; size?: 'sm' | 'md' }) {
  const m = STATUS_META[status];
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-semibold ${m.fg} ${m.bg} ${size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'}`}
    >
      <Icon size={size === 'sm' ? 12 : 14} aria-hidden />
      {m.label}
    </span>
  );
}

export const Sparkline = memo(function Sparkline({
  values,
  low,
  high,
  width = 120,
  height = 28,
  color = '#6cd3ff',
}: {
  values: number[];
  low: number;
  high: number;
  width?: number;
  height?: number;
  color?: string;
}) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden className="opacity-40" />;
  const min = Math.min(low - 0.5, ...values);
  const max = Math.max(high + 0.5, ...values);
  const y = (v: number) => height - 2 - ((v - min) / (max - min)) * (height - 4);
  const step = width / (values.length - 1);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} role="img" aria-label={`Temperature trend, last value ${values[values.length - 1]} °C`}>
      <rect x={0} y={y(high)} width={width} height={Math.max(0, y(low) - y(high))} fill="#3ecf8e" opacity={0.07} />
      <line x1={0} x2={width} y1={y(high)} y2={y(high)} stroke="#ff5d5d" strokeOpacity={0.35} strokeDasharray="2 3" />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
});

/** Re-renders itself once per second for relative times without touching parents. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Stat({ label, value, sub, tone, children }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; children?: ReactNode }) {
  return (
    <div className="panel min-w-0 px-4 py-3">
      <div className="label">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular ${tone ?? ''}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-3">{sub}</div>}
      {children}
    </div>
  );
}

const PHASE_META: Record<StreamPhase, { label: string; cls: string; Icon: typeof Radio; spin?: boolean }> = {
  loading: { label: 'Loading history', cls: 'text-ice bg-ice-dim/40', Icon: Loader2, spin: true },
  live: { label: 'Live', cls: 'text-ok bg-ok-bg', Icon: Radio },
  paused: { label: 'Paused · data still merging', cls: 'text-warn bg-warn-bg', Icon: PauseCircle },
  reconnecting: { label: 'Reconnecting', cls: 'text-warn bg-warn-bg', Icon: WifiOff },
  'catching-up': { label: 'Catching up from MongoDB', cls: 'text-ice bg-ice-dim/40', Icon: RefreshCw, spin: true },
  'refresh-required': { label: 'Gap too large — refresh required', cls: 'text-crit bg-crit-bg', Icon: AlertTriangle },
  error: { label: 'Error', cls: 'text-crit bg-crit-bg', Icon: AlertTriangle },
};

export function PhasePill({ phase }: { phase: StreamPhase }) {
  const m = PHASE_META[phase];
  return (
    <span role="status" aria-live="polite" aria-label={`Stream state: ${m.label}`} data-testid="stream-phase" className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${m.cls}`}>
      <m.Icon size={13} className={m.spin ? 'animate-spin' : ''} aria-hidden />
      {m.label}
    </span>
  );
}

export function Empty({ icon: Icon = Hourglass, title, children }: { icon?: typeof Radio; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center text-ink-3">
      <Icon size={22} aria-hidden />
      <div className="text-sm font-semibold text-ink-2">{title}</div>
      {children && <div className="max-w-sm text-xs">{children}</div>}
    </div>
  );
}

export function SimTag({ title = 'Simulated value for demonstration' }: { title?: string }) {
  return (
    <span className="sim-tag" title={title}>
      SIM
    </span>
  );
}

/** Heat-exposure budget bar: cumulative °C·min outside the band vs the configured demo budget. */
export function BudgetBar({ used, budget, compact = false }: { used: number; budget: number; compact?: boolean }) {
  const pct = budget > 0 ? (used / budget) * 100 : 0;
  const tone = pct >= 100 ? 'bg-crit' : pct >= 50 ? 'bg-warn' : 'bg-ok';
  const text = pct >= 100 ? 'text-crit' : pct >= 50 ? 'text-warn' : 'text-ink-2';
  return (
    <div className="min-w-0" title={`${used.toFixed(1)} of ${budget} °C·min heat-exposure budget used (demo calculation)`}>
      <div className={`h-1.5 w-full rounded-full bg-line ${compact ? '' : 'mt-1'}`}>
        <div className={`h-1.5 rounded-full ${tone}`} style={{ width: `${Math.min(100, Math.max(pct > 0 ? 3 : 0, pct))}%` }} />
      </div>
      <div className={`mt-0.5 text-[11px] tabular ${text}`}>{compact ? `${Math.round(pct)} %` : `${used.toFixed(1)} / ${budget} °C·min (${Math.round(pct)} %)`}</div>
    </div>
  );
}
