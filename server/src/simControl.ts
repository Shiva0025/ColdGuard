import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { FaultRequest, SimCommandAck, SimCommandMsg, SimulatorStatus } from '@coldguard/shared';
import type { Namespace, Socket } from 'socket.io';

export interface SimDesired {
  running: boolean;
  deviceCount: number;
  intervalMs: number;
  seed: number;
}

/**
 * Control plane for the external simulator process. The simulator connects to
 * the `/agent` namespace with its agent credential, receives desired state and
 * fault commands, and reports status. Telemetry itself still goes through the
 * normal authenticated HTTP ingest API — this channel never carries readings.
 */
export class SimControl {
  desired: SimDesired = { running: true, deviceCount: 24, intervalMs: 1000, seed: 42 };
  status: SimulatorStatus | null = null;
  private ns: Namespace | null = null;
  private child: ChildProcess | null = null;
  faultLog: { at: number; by: string; fault: FaultRequest }[] = [];
  onCommandAck: (a: SimCommandAck) => void = () => {};
  onAgentConnected: () => void = () => {};

  attach(ns: Namespace) {
    this.ns = ns;
    ns.on('connection', (s: Socket) => {
      s.emit('control', this.desired);
      s.on('command:ack', (a: SimCommandAck) => {
        if (a && typeof a.id === 'string') this.onCommandAck(a);
      });
      setTimeout(() => this.onAgentConnected(), 200);
      s.on('status', (st: SimulatorStatus) => {
        if (st && typeof st === 'object') this.status = { ...st, connected: true, lastSeenAt: Date.now() };
      });
      s.on('disconnect', () => {
        if (this.status) this.status = { ...this.status, connected: false };
      });
    });
  }

  current(): SimulatorStatus | null {
    if (!this.status) return null;
    const stale = Date.now() - this.status.lastSeenAt > 5000;
    return stale ? { ...this.status, connected: false } : this.status;
  }

  connected() {
    return !!this.ns && this.ns.sockets.size > 0;
  }

  update(patch: Partial<SimDesired>) {
    this.desired = { ...this.desired, ...patch };
    this.ns?.emit('control', this.desired);
    return this.desired;
  }

  fault(f: FaultRequest, by: string) {
    this.faultLog.unshift({ at: Date.now(), by, fault: f });
    this.faultLog.length = Math.min(this.faultLog.length, 50);
    this.ns?.emit('fault', f);
  }

  /** Send an operator command to the simulator; resolves with its delivery ack (or null on timeout). */
  async sendCommand(msg: SimCommandMsg): Promise<SimCommandAck | null> {
    const sock = this.ns ? [...this.ns.sockets.values()][0] : undefined;
    if (!sock) return null;
    try {
      return await sock.timeout(3000).emitWithAck('command', msg);
    } catch {
      return null;
    }
  }

  /** Optional: run the simulator as a child process (single-container hosting). */
  spawnChild(env: NodeJS.ProcessEnv) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const entry = path.resolve(here, '../../simulator/src/index.ts');
    const tsx = path.resolve(here, '../../node_modules/.bin/tsx');
    this.child = spawn(tsx, [entry], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    this.child.on('exit', (code) => {
      console.warn(`[sim] child exited with ${code}`);
      this.child = null;
    });
  }

  stop() {
    this.child?.kill('SIGTERM');
  }
}
