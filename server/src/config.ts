import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  MONGO_URL: z.string().url().or(z.string().startsWith('mongodb')),
  JWT_SECRET: z.string().min(24, 'JWT_SECRET must be at least 24 characters'),
  JWT_TTL: z.string().default('8h'),
  AGENT_KEY: z.string().regex(/^[A-Za-z0-9_-]+\.[^\s]{16,}$/, 'AGENT_KEY must look like "<agentId>.<secret of 16+ chars>"'),
  DEMO_PASSWORD: z.string().min(8),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  ALLOW_DEMO_RESET: bool,
  SIM_AUTOSPAWN: bool,
  QUEUE_CAPACITY: z.coerce.number().int().min(100).max(1_000_000).default(20_000),
  DB_BATCH_MAX: z.coerce.number().int().min(10).max(10_000).default(1000),
  FLUSH_LINGER_MS: z.coerce.number().int().min(0).max(1000).default(15),
  TELEMETRY_EMIT_MS: z.coerce.number().int().min(20).max(5000).default(250),
  FLEET_EMIT_MS: z.coerce.number().int().min(20).max(10_000).default(1000),
  AGENT_RATE_EPS: z.coerce.number().int().min(1).max(1_000_000).default(5000),
  RETENTION_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(72),
  SLOW_CLIENT_PACKETS: z.coerce.number().int().min(5).max(10_000).default(200),
  STATIC_DIR: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Record<keyof Config, unknown>> = {}): Config {
  const parsed = ConfigSchema.safeParse({ ...env, ...overrides });
  if (!parsed.success) {
    // Report which variables are wrong, never their values.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && /change-me|dev-only/.test(cfg.JWT_SECRET)) {
    throw new Error('Refusing to start in production with the example JWT_SECRET');
  }
  return cfg;
}
