import { useState, type FormEvent } from 'react';
import { Snowflake, ShieldCheck, Eye, Radio } from 'lucide-react';
import { api, session, type SessionUser } from '../lib/api';

const ACCOUNTS = [
  { username: 'operator', title: 'Operator', desc: 'All corridors · acknowledge incidents · run demo controls', Icon: ShieldCheck },
  { username: 'viewer.deccan', title: 'Deccan viewer', desc: 'Read-only · Deccan corridor only', Icon: Eye },
  { username: 'viewer.western', title: 'Western viewer', desc: 'Read-only · Western corridor only', Icon: Eye },
];

export function LoginPage({ onLogin }: { onLogin: (u: SessionUser) => void }) {
  const [username, setUsername] = useState('operator');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; user: SessionUser }>('/auth/login', { method: 'POST', json: { username, password } });
      session.set(r.token, r.user);
      onLogin(r.user);
    } catch (err: any) {
      setError(err?.message ?? 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="grid w-full max-w-4xl gap-8 md:grid-cols-[1.1fr_1fr]">
        <section className="hero flex flex-col justify-center p-8">
          <div className="flex items-center gap-2 text-teal-300">
            <Snowflake size={28} aria-hidden />
            <span className="text-2xl font-bold tracking-tight text-white">ColdGuard</span>
          </div>
          <h1 className="mt-4 text-3xl leading-tight font-semibold tracking-tight">
            Catch a cooling failure while it is still a drift — not after the vaccines are lost.
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-200">
            Real-time monitoring for a <b>simulated</b> fleet of refrigerated vaccine shipments and cold rooms. Watch readings stream in, get an
            explained alert the moment a rule is breached, and investigate history without losing incoming data.
          </p>
          <ul className="mt-5 space-y-2 text-sm text-slate-200">
            <li className="flex gap-2">
              <Radio size={16} className="mt-0.5 shrink-0 text-teal-300" aria-hidden /> Live Socket.IO delivery, scoped to the corridors you are allowed to see.
            </li>
            <li className="flex gap-2">
              <Radio size={16} className="mt-0.5 shrink-0 text-teal-300" aria-hidden /> History from MongoDB merged with live data — no gaps, no duplicates.
            </li>
            <li className="flex gap-2">
              <Radio size={16} className="mt-0.5 shrink-0 text-teal-300" aria-hidden /> Tip: sign in as two different users in two tabs — sessions are per tab.
            </li>
          </ul>
        </section>

        <form onSubmit={submit} className="panel flex flex-col gap-4 p-6" aria-labelledby="signin">
          <h2 id="signin" className="text-lg font-semibold">
            Sign in
          </h2>
          <fieldset className="flex flex-col gap-2">
            <legend className="label mb-1">Demo accounts</legend>
            {ACCOUNTS.map((a) => (
              <label
                key={a.username}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 ${username === a.username ? 'border-ice bg-ice-dim/25' : 'border-line hover:border-line-2'}`}
              >
                <input type="radio" name="acct" className="mt-1 accent-cyan-600" checked={username === a.username} onChange={() => setUsername(a.username)} />
                <a.Icon size={17} className="mt-0.5 text-ink-2" aria-hidden />
                <span>
                  <span className="block text-sm font-semibold">{a.title}</span>
                  <span className="block text-xs text-ink-3">
                    <code>{a.username}</code> · {a.desc}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1">
            <span className="label">Username</span>
            <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {/^(localhost|127\.)/.test(window.location.hostname) && (
              <span className="text-[11px] text-ink-3">
                Local demo password is the <code>DEMO_PASSWORD</code> from <code>.env</code> (default <code>coldguard-demo</code>).
              </span>
            )}
          </label>
          {error && (
            <div role="alert" className="rounded-md bg-crit-bg px-3 py-2 text-sm text-crit">
              {error}
            </div>
          )}
          <button className="btn btn-primary justify-center py-2" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
