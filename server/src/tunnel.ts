import { spawn, type ChildProcess } from 'node:child_process';

export interface TunnelStatus {
  status: 'off' | 'starting' | 'on';
  url: string | null;
  provider: string | null;
  error: string | null;
}

export interface TunnelProvider {
  name: string;
  cmd: string;
  args: (target: string) => string[];
  /** Extracts the public URL from the tool's log output. */
  url: RegExp;
}

/** Tried in order; the first one that is installed and yields a URL wins. */
export const DEFAULT_PROVIDERS: TunnelProvider[] = [
  // Cloudflare quick tunnel: no account needed.
  { name: 'cloudflared', cmd: 'cloudflared', args: (t) => ['tunnel', '--no-autoupdate', '--url', t], url: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/ },
  // ngrok: needs `ngrok config add-authtoken <token>` once.
  { name: 'ngrok', cmd: 'ngrok', args: (t) => ['http', t, '--log', 'stdout', '--log-format', 'logfmt'], url: /url=(https:\/\/[^\s"]+)/ },
];

/**
 * Public tunnel for "judges join by QR" when the venue Wi-Fi isolates clients
 * and phones cannot reach the laptop's LAN address. Runs a tunnelling tool that
 * is already installed on this machine and reports the public HTTPS URL.
 */
export class TunnelManager {
  private child: ChildProcess | null = null;
  private starting: Promise<TunnelStatus> | null = null;
  private state: TunnelStatus = { status: 'off', url: null, provider: null, error: null };

  constructor(
    private providers: TunnelProvider[] = DEFAULT_PROVIDERS,
    private timeoutMs = 25_000,
  ) {}

  status(): TunnelStatus {
    return { ...this.state };
  }

  start(target: string): Promise<TunnelStatus> {
    if (this.state.status === 'on') return Promise.resolve(this.status());
    this.starting ??= this.run(target).finally(() => (this.starting = null));
    return this.starting;
  }

  stop() {
    const c = this.child;
    this.child = null;
    c?.kill();
    this.state = { status: 'off', url: null, provider: null, error: null };
  }

  private async run(target: string): Promise<TunnelStatus> {
    this.state = { status: 'starting', url: null, provider: null, error: null };
    const errors: string[] = [];
    for (const p of this.providers) {
      const r = await this.tryProvider(p, target);
      if (r.url) {
        this.state = { status: 'on', url: r.url, provider: p.name, error: null };
        return this.status();
      }
      errors.push(`${p.name}: ${r.error}`);
    }
    this.state = { status: 'off', url: null, provider: null, error: `Could not open a public tunnel (${errors.join('; ')})` };
    return this.status();
  }

  private tryProvider(p: TunnelProvider, target: string): Promise<{ url?: string; error?: string }> {
    return new Promise((resolve) => {
      let done = false;
      let tail = '';
      const child = spawn(p.cmd, p.args(target), { stdio: ['ignore', 'pipe', 'pipe'] });
      const finish = (r: { url?: string; error?: string }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (r.url) this.child = child;
        else child.kill();
        resolve(r);
      };
      const timer = setTimeout(() => finish({ error: `no public URL after ${Math.round(this.timeoutMs / 1000)} s` }), this.timeoutMs);
      const onData = (b: Buffer) => {
        if (done) return;
        tail = (tail + b.toString()).slice(-4000);
        const m = p.url.exec(tail);
        if (m) finish({ url: m[1] ?? m[0] });
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      child.on('error', (e: NodeJS.ErrnoException) => finish({ error: e.code === 'ENOENT' ? 'not installed' : e.message }));
      child.on('exit', (code) => {
        if (!done) return finish({ error: lastError(tail) ?? `exited with code ${code}` });
        // The tunnel died after it was up (network drop, tool killed).
        if (this.child === child) {
          this.child = null;
          this.state = { status: 'off', url: null, provider: null, error: `${p.name} tunnel closed — open it again` };
        }
      });
    });
  }
}

function lastError(log: string): string | null {
  const lines = log.split('\n').map((l) => l.trim()).filter(Boolean);
  const line = [...lines].reverse().find((l) => /err|fail|auth/i.test(l)) ?? lines.at(-1);
  return line ? line.replace(/\s+/g, ' ').slice(0, 200) : null;
}
