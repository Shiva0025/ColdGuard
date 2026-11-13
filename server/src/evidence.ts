import { createHash } from 'node:crypto';
import { blockHeader, canonicalReading, genesisSeed, type EvidenceBlock, type Reading } from '@coldguard/shared';
import type { Collection } from 'mongodb';
import type { TelemetryDoc } from './db.js';
import { toReading } from './pipeline.js';

export interface EvidenceDoc extends EvidenceBlock {
  _id: string; // `${d}:${n}`
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const leafOf = (r: Reading) => sha256(canonicalReading(r)).slice(0, 16);

/** Pure verification of a contiguous run of blocks against the readings they cover. */
export function verifyBlocks(blocks: EvidenceBlock[], readingsByBlock: Map<number, Reading[]>, prevOfFirst?: string): VerifyResult {
  let readingsChecked = 0;
  let prev = prevOfFirst;
  for (const b of blocks) {
    if (prev !== undefined && b.prevHash !== prev) return { ok: false, blocksChecked: blocks.indexOf(b), readingsChecked, firstBreak: { block: b.n, reason: 'link broken', detail: `block ${b.n} does not point at block ${b.n - 1}` } };
    if (sha256(blockHeader(b)) !== b.hash) return { ok: false, blocksChecked: blocks.indexOf(b), readingsChecked, firstBreak: { block: b.n, reason: 'block header altered', detail: `block ${b.n} hash mismatch` } };
    const rs = (readingsByBlock.get(b.n) ?? []).slice().sort((x, y) => x.c - y.c);
    const leaves = rs.map(leafOf);
    // Pinpoint the first differing reading (altered / missing / inserted).
    for (let i = 0; i < Math.max(leaves.length, b.leaves.length); i++) {
      if (leaves[i] === b.leaves[i]) continue;
      const at = blocks.indexOf(b);
      const r = rs[i];
      if (!r || b.leaves.includes(leaves[i]))
        return { ok: false, blocksChecked: at, readingsChecked, firstBreak: { block: b.n, reason: 'reading missing', detail: `a reading sealed in block ${b.n} is no longer stored` } };
      if (leaves.length > b.leaves.length)
        return { ok: false, blocksChecked: at, readingsChecked, firstBreak: { block: b.n, reason: 'extra reading', eventId: r.id, detail: `${r.id} was never sealed in block ${b.n}` } };
      return {
        ok: false,
        blocksChecked: at,
        readingsChecked,
        firstBreak: { block: b.n, reason: 'reading altered', eventId: r.id, detail: `stored values of ${r.id} (now ${r.tc} °C) do not match what was sealed` },
      };
    }
    if (sha256(rs.map(canonicalReading).join('\n')) !== b.readingsHash)
      return { ok: false, blocksChecked: blocks.indexOf(b), readingsChecked, firstBreak: { block: b.n, reason: 'reading altered', detail: 'readings hash mismatch' } };
    readingsChecked += rs.length;
    prev = b.hash;
  }
  return { ok: true, blocksChecked: blocks.length, readingsChecked };
}

export interface VerifyResult {
  ok: boolean;
  blocksChecked: number;
  readingsChecked: number;
  firstBreak?: { block: number; reason: string; eventId?: string; detail: string };
}

/**
 * Per-device, hash-linked evidence chain over persisted readings, in commit
 * (cursor) order. Readings are sealed into blocks every ≤ 60 readings or ≤ 10 s.
 * Each block stores a short leaf hash per reading, the hash of all canonical
 * readings, and the previous block's hash — so changing, deleting or inserting
 * any stored reading, or rewriting history, is detectable and locatable.
 * Readings persisted but not yet sealed (or lost from memory by a crash before
 * sealing) are reported as an "unsealed tail", never as verified.
 */
export class EvidenceChain {
  private pending = new Map<string, { since: number; rs: Reading[] }>();
  private heads = new Map<string, { n: number; hash: string; toC: number }>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout;
  sealedBlocks = 0;

  constructor(
    private col: Collection<EvidenceDoc>,
    private telemetry: Collection<TelemetryDoc>,
    private opts = { maxReadings: 60, maxAgeMs: 10_000 },
  ) {
    this.timer = setInterval(() => this.sealDue(), 2000);
    this.timer.unref();
  }

  async init() {
    await this.col.createIndex({ d: 1, n: -1 }, { name: 'device_block' });
  }

  onPersisted(readings: Reading[]) {
    const now = Date.now();
    for (const r of readings) {
      let p = this.pending.get(r.d);
      if (!p) this.pending.set(r.d, (p = { since: now, rs: [] }));
      p.rs.push(r);
      if (p.rs.length >= this.opts.maxReadings) this.seal(r.d);
    }
  }

  private sealDue() {
    const now = Date.now();
    for (const [d, p] of this.pending) if (now - p.since >= this.opts.maxAgeMs) this.seal(d);
  }

  private seal(d: string) {
    const p = this.pending.get(d);
    if (!p || !p.rs.length) return;
    this.pending.delete(d);
    const rs = p.rs.sort((a, b) => a.c - b.c);
    this.chain = this.chain
      .then(async () => {
        const head = await this.head(d);
        const b: EvidenceBlock = {
          d,
          n: head.n + 1,
          fromC: rs[0].c,
          toC: rs[rs.length - 1].c,
          count: rs.length,
          leaves: rs.map(leafOf),
          readingsHash: sha256(rs.map(canonicalReading).join('\n')),
          prevHash: head.hash,
          hash: '',
          sealedAt: Date.now(),
        };
        b.hash = sha256(blockHeader(b));
        await this.col.insertOne({ _id: `${d}:${b.n}`, ...b });
        this.heads.set(d, { n: b.n, hash: b.hash, toC: b.toC });
        this.sealedBlocks++;
      })
      .catch((e) => console.error('[evidence] seal failed', e?.message));
  }

  private async head(d: string) {
    const cached = this.heads.get(d);
    if (cached) return cached;
    const last = await this.col.find({ d }).sort({ n: -1 }).limit(1).next();
    const h = last ? { n: last.n, hash: last.hash, toC: last.toC } : { n: -1, hash: sha256(genesisSeed(d)), toC: 0 };
    this.heads.set(d, h);
    return h;
  }

  /** Seal everything pending now (tests, shutdown, before verification). */
  async flush() {
    for (const d of [...this.pending.keys()]) this.seal(d);
    await this.chain;
  }

  /** Blocks for a device (optionally the last `limit`) in order. */
  async blocks(d: string, limit = 500): Promise<EvidenceBlock[]> {
    const docs = await this.col.find({ d }).sort({ n: -1 }).limit(limit).toArray();
    return docs.reverse().map(({ _id, ...b }) => b);
  }

  async readingsFor(d: string, blocks: EvidenceBlock[]): Promise<Map<number, Reading[]>> {
    const out = new Map<number, Reading[]>();
    if (!blocks.length) return out;
    const docs = await this.telemetry.find({ d, c: { $gte: blocks[0].fromC, $lte: blocks[blocks.length - 1].toC } }).sort({ c: 1 }).toArray();
    let bi = 0;
    for (const doc of docs) {
      while (bi < blocks.length && doc.c > blocks[bi].toC) bi++;
      if (bi >= blocks.length) break;
      // A reading between two blocks' ranges was never sealed: attach it to the next block so it shows as "extra".
      const arr = out.get(blocks[bi].n) ?? [];
      arr.push(toReading(doc));
      out.set(blocks[bi].n, arr);
    }
    return out;
  }

  /** Verify the most recent `limit` blocks of a device's chain against MongoDB. */
  async verify(d: string, limit = 500) {
    await this.flush();
    const blocks = await this.blocks(d, limit);
    const readings = await this.readingsFor(d, blocks);
    let prevOfFirst: string | undefined;
    if (blocks.length && blocks[0].n === 0) prevOfFirst = sha256(genesisSeed(d));
    else if (blocks.length) prevOfFirst = (await this.col.findOne({ _id: `${d}:${blocks[0].n - 1}` }))?.hash;
    const res = verifyBlocks(blocks, readings, prevOfFirst);
    const last = blocks[blocks.length - 1];
    const unsealed = await this.telemetry.countDocuments({ d, c: { $gt: last?.toC ?? 0 } });
    return { ...res, deviceId: d, totalBlocks: last ? last.n + 1 : 0, head: last?.hash ?? null, unsealedTail: unsealed, verifiedAt: Date.now() };
  }

  /**
   * Wipe the chain (demo reset). Runs on the sealer's own promise chain so no
   * in-flight seal can compute a head before the wipe and insert after it.
   */
  resetAll(): Promise<void> {
    const run = this.chain.then(async () => {
      this.pending.clear();
      await this.col.deleteMany({});
      this.heads.clear();
    });
    this.chain = run.catch((e) => console.error('[evidence] reset failed', e?.message));
    return run;
  }

  stop() {
    clearInterval(this.timer);
  }
}
