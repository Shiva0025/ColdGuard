/**
 * Independent verifier for a ColdGuard evidence report (JSON from
 * GET /api/incidents/:id/report). Needs no database or server: it recomputes
 * every reading leaf, block hash and block link from the file alone.
 *
 *   npm run verify-report -- coldguard-report-XYZ.json
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EvidenceBlock, Reading } from '@coldguard/shared';
import { verifyBlocks } from './evidence.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run verify-report -- <report.json>');
  process.exit(2);
}
// npm runs workspace scripts inside server/, so resolve relative paths against where the user ran npm.
const rep = JSON.parse(fs.readFileSync(path.resolve(process.env.INIT_CWD ?? process.cwd(), file), 'utf8'));
if (rep.format !== 'coldguard-evidence-report/v1') {
  console.error('not a ColdGuard evidence report');
  process.exit(2);
}
const blocks: EvidenceBlock[] = rep.chain.blocks;
const readings: Reading[] = rep.readings;
const byBlock = new Map<number, Reading[]>();
for (const r of readings) {
  const b = blocks.find((x) => r.c <= x.toC); // blocks are in order; anything between ranges lands in the next block
  if (!b) continue;
  byBlock.set(b.n, [...(byBlock.get(b.n) ?? []), r]);
}
const res = verifyBlocks(blocks, byBlock, rep.chain.prevHashOfFirstBlock ?? undefined);
console.log(`Incident ${rep.incident.id} (${rep.incident.type}) on ${rep.incident.deviceId}`);
console.log(`Blocks ${blocks[0]?.n ?? '-'}…${blocks[blocks.length - 1]?.n ?? '-'} · ${res.readingsChecked} readings checked`);
if (res.ok) {
  console.log(`VERIFIED ✓  chain head ${blocks[blocks.length - 1]?.hash.slice(0, 16)}…`);
  if (rep.chain.unsealedReadingsInWindow) console.log(`note: ${rep.chain.unsealedReadingsInWindow} reading(s) in the window were not yet sealed and are NOT covered`);
  process.exit(0);
}
console.log(`FAILED ✗  block ${res.firstBreak!.block}: ${res.firstBreak!.reason} — ${res.firstBreak!.detail}`);
process.exit(1);
