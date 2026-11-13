import { z } from 'zod';

/**
 * Validation limits for ingestion. These are platform safety limits, not
 * cold-chain guidance. They bound what a (simulated) sensor may report.
 */
export const LIMITS = {
  maxBatchEvents: 500,
  maxBodyBytes: 512 * 1024,
  /** Reject readings stamped further in the future than this (device clock skew). */
  maxFutureSkewMs: 30_000,
  /** Reject readings older than this (late-data acceptance window). */
  maxAgeMs: 6 * 60 * 60 * 1000,
  maxSubscriptions: 25,
  maxHistoryRawPoints: 5000,
  maxHistoryBuckets: 720,
  maxCatchUpEvents: 5000,
} as const;

export const METRIC_RANGES = {
  tempC: { min: -40, max: 70, unit: '°C' },
  humidityPct: { min: 0, max: 100, unit: '%RH' },
  batteryPct: { min: 0, max: 100, unit: '%' },
} as const;

const idString = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9._:-]+$/, 'only [A-Za-z0-9._:-] allowed');

/** off = compressor idle (thermostat cycling), on = cooling, fault = compressor failed, backup = auxiliary cooling unit running. */
export const CoolingState = z.enum(['on', 'off', 'fault', 'backup']);
export type CoolingState = z.infer<typeof CoolingState>;
export const COOLING_CODE: Record<CoolingState, number> = { off: 0, on: 1, fault: 2, backup: 3 };
export const COOLING_FROM_CODE: CoolingState[] = ['off', 'on', 'fault', 'backup'];

export const MetricsSchema = z
  .object({
    tempC: z.number().finite().min(METRIC_RANGES.tempC.min).max(METRIC_RANGES.tempC.max),
    humidityPct: z.number().finite().min(0).max(100),
    batteryPct: z.number().finite().min(0).max(100),
    cooling: CoolingState,
    /** Simulated GPS-derived progress along the lane, 0..1 (shipments only). */
    routeProgress: z.number().min(0).max(1).optional(),
    /** Refrigerated compartment door sensor. */
    doorOpen: z.boolean().optional(),
  })
  .strict();

/** One telemetry reading as sent by a device/agent. */
export const TelemetryEventSchema = z
  .object({
    eventId: idString,
    deviceId: idString,
    /** Changes whenever the device restarts and its sequence counter resets. */
    sessionId: idString,
    seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    /** Device clock, epoch milliseconds. */
    observedAt: z.number().int().positive(),
    metrics: MetricsSchema,
  })
  .strict();
export type TelemetryEventIn = z.infer<typeof TelemetryEventSchema>;

export const IngestBatchSchema = z
  .object({
    events: z.array(z.unknown()).min(1).max(LIMITS.maxBatchEvents),
  })
  .strict();

export const LoginSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(256),
  })
  .strict();

export const RulesSchema = z
  .object({
    tempLowC: z.number().min(-40).max(40),
    tempHighC: z.number().min(-30).max(60),
    sustainSec: z.number().int().min(5).max(3600),
    hysteresisC: z.number().min(0).max(5),
    recoverySec: z.number().int().min(5).max(3600),
    driftCPerMin: z.number().min(0.1).max(20),
    driftWindowSec: z.number().int().min(30).max(1800),
    offlineSec: z.number().int().min(5).max(3600),
    lowBatteryPct: z.number().min(1).max(50),
    /** Demo heat-exposure budget: cumulative °C·min outside the band before the budget is exhausted. */
    exposureBudgetCMin: z.number().min(1).max(10_000).default(20),
  })
  .strict()
  .refine((r) => r.tempHighC - r.tempLowC >= 2 * r.hysteresisC + 0.5, {
    message: 'high threshold must exceed low threshold by more than twice the hysteresis',
  });
export type Rules = z.infer<typeof RulesSchema>;

/** Demonstration defaults. Configurable; not universal vaccine-storage guidance. */
export const DEFAULT_RULES: Rules = {
  tempLowC: 2,
  tempHighC: 8,
  sustainSec: 20,
  hysteresisC: 0.5,
  recoverySec: 20,
  driftCPerMin: 1.5,
  driftWindowSec: 60,
  offlineSec: 15,
  lowBatteryPct: 15,
  exposureBudgetCMin: 20,
};

export const SubscribeSchema = z
  .object({
    groups: z.array(idString).max(LIMITS.maxSubscriptions).default([]),
    devices: z.array(idString).max(LIMITS.maxSubscriptions).default([]),
  })
  .strict();
export type SubscribeRequest = z.infer<typeof SubscribeSchema>;

export const AckSchema = z.object({ note: z.string().max(500).optional() }).strict();

export const SimControlSchema = z
  .object({
    running: z.boolean().optional(),
    deviceCount: z.number().int().min(1).max(2000).optional(),
    intervalMs: z.number().int().min(100).max(10_000).optional(),
    seed: z.number().int().min(0).max(2 ** 31).optional(),
  })
  .strict();

export const FaultSchema = z
  .object({
    kind: z.enum(['cooling_failure', 'door_open', 'sensor_dropout', 'reconnect', 'duplicates', 'out_of_order', 'low_battery', 'restore']),
    deviceId: idString.optional(),
    durationSec: z.number().int().min(1).max(600).optional(),
  })
  .strict();
export type FaultRequest = z.infer<typeof FaultSchema>;

/** Operator response commands (simulated actuators). */
export const CommandKind = z.enum(['close_door', 'restore_cooling', 'backup_cooling']);
export type CommandKind = z.infer<typeof CommandKind>;
export const CommandRequestSchema = z
  .object({
    kind: CommandKind,
    incidentId: z.string().max(200).optional(),
  })
  .strict();

export const GuestClaimSchema = z
  .object({
    code: z.string().regex(/^[A-Za-z0-9]{6,16}$/),
    name: z
      .string()
      .trim()
      .min(1)
      .max(24)
      .regex(/^[\p{L}\p{N} .'-]+$/u, 'letters, numbers, spaces and . \' - only'),
  })
  .strict();
