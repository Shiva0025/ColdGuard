import { COMMAND_LABEL, type Command, type CommandKind, type Reading, type SimCommandAck, type SimCommandMsg } from '@coldguard/shared';
import type { Collection } from 'mongodb';

/** Where a device's commands go: the simulator agent, or the judge's phone driving it. */
export interface CommandTransport {
  connected(deviceId: string): boolean;
  send(msg: SimCommandMsg): Promise<SimCommandAck | null>;
  label(deviceId: string): string;
}

export interface CommandDoc extends Omit<Command, 'id'> {
  _id: string;
}

const toDoc = ({ id, ...rest }: Command): CommandDoc => ({ _id: id, ...rest });
export const commandFromDoc = ({ _id, ...rest }: CommandDoc): Command => ({ id: _id, ...rest });

/**
 * Operator command lifecycle:
 *   requested ──(simulator receives)──▶ delivered [queued on device if offline]
 *             ──(device applies)──────▶ acknowledged (+ simulated no-intervention projection)
 *             ──(telemetry proves it)─▶ effect_observed
 * The last step is decided ONLY from persisted, in-order readings — not from
 * the simulator's word — so the UI shows what the data actually confirms.
 */
export class CommandManager {
  private open = new Map<string, Command>(); // not yet effect_observed / failed
  private listeners: ((c: Command) => void)[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private col: Collection<CommandDoc>,
    private transport: CommandTransport,
    private resolveGroup: (deviceId: string) => string | undefined,
    private latest: (deviceId: string) => { t: number | null; tc: number | null },
    private incidentNote: (incidentId: string, text: string, by?: string) => void,
  ) {}

  async load() {
    await this.col.createIndex({ deviceId: 1, requestedAt: -1 });
    const docs = await this.col.find({ state: { $in: ['requested', 'delivered', 'acknowledged'] } }).toArray();
    for (const d of docs) this.open.set(d._id, commandFromDoc(d));
  }

  onChange(fn: (c: Command) => void) {
    this.listeners.push(fn);
  }

  async list(deviceId: string, limit = 20): Promise<Command[]> {
    await this.chain;
    return (await this.col.find({ deviceId }).sort({ requestedAt: -1 }).limit(limit).toArray()).map(commandFromDoc);
  }

  async create(deviceId: string, kind: CommandKind, by: string, incidentId?: string): Promise<Command> {
    const groupId = this.resolveGroup(deviceId)!;
    const now = Date.now();
    const c: Command = {
      id: `cmd-${deviceId}-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      deviceId,
      groupId,
      kind,
      ...(incidentId ? { incidentId } : {}),
      state: 'requested',
      requestedBy: by,
      requestedAt: now,
      timeline: [{ at: now, state: 'requested', text: `${COMMAND_LABEL[kind]} requested by ${by}` }],
    };
    this.open.set(c.id, c);
    await this.col.insertOne(toDoc(c));
    this.emit(c);
    if (incidentId) this.incidentNote(incidentId, `Action requested: ${COMMAND_LABEL[kind]}`, by);
    void this.deliver(c);
    return c;
  }

  private async deliver(c: Command) {
    const who = this.transport.label(c.deviceId);
    if (!this.transport.connected(c.deviceId)) {
      c.timeline.push({ at: Date.now(), state: 'note', text: `${who} not connected — will deliver when it connects` });
      this.save(c);
      return;
    }
    const ack = await this.transport.send({ id: c.id, deviceId: c.deviceId, kind: c.kind });
    if (!ack) {
      c.timeline.push({ at: Date.now(), state: 'note', text: `No answer from ${who} within 3 s — will retry on reconnect` });
      this.save(c);
      return;
    }
    if (ack.phase === 'failed') return this.fail(c, ack.reason ?? 'rejected by simulator');
    if (c.state === 'requested') {
      c.state = 'delivered';
      c.deliveredAt = Date.now();
      c.queuedOffline = !!ack.queuedOffline;
      c.timeline.push({
        at: c.deliveredAt,
        state: 'delivered',
        text: ack.queuedOffline ? 'Delivered to uplink — truck is offline, command queued on the device until connectivity returns' : 'Delivered to the truck',
      });
      this.save(c);
    }
  }

  /** Re-send commands still in `requested` (e.g. after the agent or a phone connects). */
  redeliver(deviceId?: string) {
    for (const c of this.open.values()) if (c.state === 'requested' && (!deviceId || c.deviceId === deviceId)) void this.deliver(c);
  }

  onAck(a: SimCommandAck) {
    const c = this.open.get(a.id);
    if (!c) return;
    if (a.phase === 'failed') return this.fail(c, a.reason ?? 'failed on device');
    if (a.phase !== 'applied') return;
    const at = a.appliedAt ?? Date.now();
    if (c.state === 'requested') {
      // The device's "applied" can overtake the delivery ack; delivery is implied by it.
      c.state = 'delivered';
      c.deliveredAt = at;
      c.timeline.push({ at, state: 'delivered', text: 'Delivered to the truck' });
    }
    c.state = 'acknowledged';
    c.acknowledgedAt = at;
    const cur = this.latest(c.deviceId);
    if (cur.tc != null && cur.t != null) c.baseline = { t: cur.t, tc: cur.tc };
    if (a.counterfactual?.length) {
      c.counterfactual = {
        points: a.counterfactual,
        horizonSec: a.horizonSec ?? 900,
        label: 'Simulated: same thermal model cloned at acknowledgement, continued without this command',
      };
    }
    c.timeline.push({
      at,
      state: 'acknowledged',
      text: `Truck applied the command${c.queuedOffline ? ' after reconnecting' : ''}${a.reason ? ` (note: ${a.reason})` : ''}. Waiting for telemetry to confirm the effect.`,
    });
    this.save(c);
  }

  /** Called with persisted in-order readings. */
  onReadings(readings: Reading[]) {
    if (this.open.size === 0) return;
    for (const r of readings) {
      if (r.late) continue;
      for (const c of this.open.values()) {
        if (c.deviceId !== r.d || c.state !== 'acknowledged' || !c.acknowledgedAt || r.t < c.acknowledgedAt) continue;
        const text = this.effect(c, r);
        if (!text) continue;
        c.state = 'effect_observed';
        c.effectAt = r.t;
        c.effect = { eventId: r.id, t: r.t, tc: r.tc, text };
        c.timeline.push({ at: r.t, state: 'effect_observed', text: `Effect observed in telemetry: ${text}` });
        this.open.delete(c.id);
        this.save(c);
        if (c.incidentId) this.incidentNote(c.incidentId, `Effect observed: ${text}`);
      }
    }
  }

  private effect(c: Command, r: Reading): string | null {
    const base = c.baseline?.tc ?? r.tc;
    const drop = base - r.tc;
    if (c.kind === 'close_door') return r.door === 0 ? `door sensor reports closed (reading ${r.id})` : null;
    if (c.kind === 'restore_cooling' && (r.cs === 0 || r.cs === 1) && drop >= 0.3)
      return `primary cooling running and temperature down ${drop.toFixed(1)} °C (${base.toFixed(1)} → ${r.tc.toFixed(1)} °C)`;
    if (c.kind === 'backup_cooling' && r.cs === 3 && drop >= 0.3) return `backup cooling running and temperature down ${drop.toFixed(1)} °C (${base.toFixed(1)} → ${r.tc.toFixed(1)} °C)`;
    return null;
  }

  private fail(c: Command, reason: string) {
    c.state = 'failed';
    c.failure = reason;
    c.timeline.push({ at: Date.now(), state: 'failed', text: reason });
    this.open.delete(c.id);
    this.save(c);
  }

  private save(c: Command) {
    const snap = structuredClone(c);
    this.chain = this.chain
      .then(async () => {
        const { _id, ...rest } = toDoc(snap);
        await this.col.updateOne({ _id }, { $set: rest });
        this.emit(snap);
      })
      .catch((e) => console.error('[commands] write failed', e?.message));
  }

  private emit(c: Command) {
    for (const l of this.listeners) l(c);
  }

  pendingFor(deviceId: string) {
    let n = 0;
    for (const c of this.open.values()) if (c.deviceId === deviceId && (c.state === 'requested' || c.state === 'delivered')) n++;
    return n;
  }

  flush() {
    return this.chain;
  }

  reset() {
    this.open.clear();
  }
}
