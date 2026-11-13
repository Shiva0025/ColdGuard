import './env.js';
import { loadConfig } from './config.js';
import { createColdGuard } from './app.js';

const cfg = loadConfig();
const cg = await createColdGuard(cfg);
console.log(`[coldguard] listening on :${cg.port} (queue ${cfg.QUEUE_CAPACITY}, db batch ${cfg.DB_BATCH_MAX}, emit ${cfg.TELEMETRY_EMIT_MS}/${cfg.FLEET_EMIT_MS} ms)`);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`[coldguard] ${sig}: draining ingest queue and closing`);
    await cg.stop();
    process.exit(0);
  });
}
