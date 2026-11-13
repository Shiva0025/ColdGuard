import './env.js';
import { DEFAULT_RULES, GROUPS, MAX_DEVICES, buildFleet, guestFleet } from '@coldguard/shared';
import { hashPassword, sha256 } from './auth.js';
import type { Collections } from './db.js';

/**
 * Idempotent seed: groups, device catalogue, demo users and the simulator's
 * ingest credential. Passwords come from configuration and are stored as
 * bcrypt hashes; the agent secret is stored as SHA-256.
 */
export async function seedData(col: Collections, opts: { demoPassword: string; agentKey: string }) {
  await col.groups.bulkWrite(
    GROUPS.map(({ id, ...g }) => ({ updateOne: { filter: { _id: id }, update: { $set: g }, upsert: true } })),
  );
  const fleet = [...buildFleet(MAX_DEVICES), ...guestFleet()];
  for (let i = 0; i < fleet.length; i += 500) {
    await col.devices.bulkWrite(
      fleet.slice(i, i + 500).map(({ id, ...d }) => ({ updateOne: { filter: { _id: id }, update: { $set: d }, upsert: true } })),
    );
  }
  const pw = await hashPassword(opts.demoPassword);
  const users = [
    { _id: 'operator', role: 'operator' as const, displayName: 'Asha (Operator)', groups: ['deccan', 'western', 'stress', 'guest'] },
    { _id: 'viewer.deccan', role: 'viewer' as const, displayName: 'Ravi (Deccan viewer)', groups: ['deccan'] },
    { _id: 'viewer.western', role: 'viewer' as const, displayName: 'Meera (Western viewer)', groups: ['western'] },
  ];
  for (const u of users) {
    const { _id, ...rest } = u;
    await col.users.updateOne({ _id }, { $set: { ...rest, passwordHash: pw } }, { upsert: true });
  }
  const dot = opts.agentKey.indexOf('.');
  const agentId = opts.agentKey.slice(0, dot);
  await col.agents.updateOne(
    { _id: agentId },
    { $set: { secretSha256: sha256(opts.agentKey.slice(dot + 1)), groups: GROUPS.map((g) => g.id), description: 'ColdGuard simulator / load generator' } },
    { upsert: true },
  );
  await col.settings.updateOne({ _id: 'rules' }, { $setOnInsert: { rules: DEFAULT_RULES, updatedAt: new Date() } }, { upsert: true });
  return { devices: fleet.length, users: users.map((u) => u._id), agentId };
}

// CLI: `npm run seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('./config.js');
  const { connectDb } = await import('./db.js');
  const cfg = loadConfig();
  const db = await connectDb(cfg.MONGO_URL, { retentionHours: cfg.RETENTION_HOURS });
  const out = await seedData(db.col, { demoPassword: cfg.DEMO_PASSWORD, agentKey: cfg.AGENT_KEY });
  console.log(`[seed] ${out.devices} devices, users: ${out.users.join(', ')}, agent: ${out.agentId}`);
  await db.close();
}
