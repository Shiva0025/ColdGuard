import type { DeviceStatus } from '@coldguard/shared';

export const fmtTemp = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v.toFixed(d)} °C`);
export const fmtPct = (v: number | null | undefined, d = 0) => (v == null ? '—' : `${v.toFixed(d)} %`);
export const fmtTime = (ms: number | null | undefined) =>
  ms == null ? '—' : new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const fmtDateTime = (ms: number | null | undefined) =>
  ms == null ? '—' : new Date(ms).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function fmtAgo(ms: number | null | undefined, now: number) {
  if (ms == null) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

export const fmtInr = (v: number) =>
  v >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `₹${(v / 1e5).toFixed(1)} L` : `₹${Math.round(v).toLocaleString('en-IN')}`;
export const fmtInt = (v: number) => Math.round(v).toLocaleString('en-IN');
export const fmtMs = (v: number | null | undefined) => (v == null ? '—' : v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`);

export const STATUS_META: Record<DeviceStatus | 'nodata', { label: string; fg: string; bg: string; dot: string }> = {
  healthy: { label: 'Healthy', fg: 'text-ok', bg: 'bg-ok-bg', dot: '#3ecf8e' },
  warning: { label: 'Warning', fg: 'text-warn', bg: 'bg-warn-bg', dot: '#f0b429' },
  critical: { label: 'Critical', fg: 'text-crit', bg: 'bg-crit-bg', dot: '#ff5d5d' },
  offline: { label: 'Offline', fg: 'text-off', bg: 'bg-off-bg', dot: '#94a3b3' },
  nodata: { label: 'Awaiting data', fg: 'text-ink-3', bg: 'bg-off-bg', dot: '#56636e' },
};

export const COOLING_LABEL = ['Off (cycling)', 'On', 'FAULT', 'Backup unit'];
