import 'dotenv/config';
import { z } from 'zod';

/**
 * Runtime configuration. Parsed once at boot; a bad value must fail the
 * process, not surface later as a confusing runtime error.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().positive().default(3001),
  API_BASE_URL: z.string().url().default('http://localhost:3001'),
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  REDIS_URL: z.string().optional().default(''),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(120),

  AGODA_MODE: z.enum(['mock', 'live']).default('mock'),
  AGODA_BASE_URL: z.string().url().default('https://api-connectivity.agoda.com'),
  AGODA_API_KEY: z.string().optional().default(''),
  AGODA_USERNAME: z.string().optional().default(''),
  AGODA_PASSWORD: z.string().optional().default(''),
  AGODA_CONTENT_LANGUAGE: z.string().default('en'),
  AGODA_TIMEOUT_CONTENT_SECONDS: z.coerce.number().int().positive().default(30),
  AGODA_TIMEOUT_SEARCH_SECONDS: z.coerce.number().int().positive().default(30),
  AGODA_TIMEOUT_PRECHECK_SECONDS: z.coerce.number().int().positive().default(60),
  AGODA_TIMEOUT_BOOKING_SECONDS: z.coerce.number().int().positive().default(120),
  AGODA_RATE_LIMIT_RPM: z.coerce.number().int().positive().default(60),
  AGODA_RATE_LIMIT_BURST: z.coerce.number().int().positive().default(10),
  AGODA_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  /**
   * Probability (0..1) that the MOCK supplier re-prices an offer at
   * precheck time. Only used in `AGODA_MODE=mock`.
   *
   * It exists so the "price went up, the customer must confirm it" path can
   * be demonstrated and tested against a running system — the flow is too
   * important to only ever be exercised in a unit test.
   */
  AGODA_MOCK_PRICE_DRIFT_RATE: z.coerce.number().min(0).max(1).default(0),

  PAYMENT_PROVIDER: z.enum(['mock', 'stripe']).default('mock'),
  PAYMENT_WEBHOOK_SECRET: z.string().default('dev-webhook-secret'),
  PAYMENT_CAPTURE_WINDOW_MINUTES: z.coerce.number().int().positive().default(30),

  FULFILLMENT_MODE: z.enum(['partner']).default('partner'),

  NOTIFY_CHANNELS: z.string().default('email,sms,webhook'),
  NOTIFY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  NOTIFY_ESCALATION_THRESHOLD: z.coerce.number().int().positive().default(3),
  OPS_ALERT_WEBHOOK_URL: z.string().optional().default(''),
  OPS_ALERT_WEBHOOK_SECRET: z.string().default('ota-ops-alert'),

  BOOKING_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
  BOOKING_POLL_MAX_MINUTES: z.coerce.number().int().positive().default(30),
});

export type Config = z.infer<typeof envSchema>;

/**
 * Secrets that ship with a development default.
 *
 * In production they MUST be replaced: a webhook that signs with a public
 * constant can be forged by anyone, and an ops alert signed with it can be
 * faked. The process refuses to start rather than run like that.
 */
const DEVELOPMENT_DEFAULTS: ReadonlyArray<{ name: keyof Config; devDefault: string }> = [
  { name: 'PAYMENT_WEBHOOK_SECRET', devDefault: 'dev-webhook-secret' },
  { name: 'OPS_ALERT_WEBHOOK_SECRET', devDefault: 'ota-ops-alert' },
];

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === 'production') {
    const insecure = DEVELOPMENT_DEFAULTS.filter(
      (entry) => String(config[entry.name]) === entry.devDefault,
    ).map((entry) => entry.name);
    if (insecure.length > 0) {
      throw new Error(
        `Refusing to start in production with development secrets: ${insecure.join(', ')}. ` +
          'Set them in the environment.',
      );
    }
  }
  cached = config;
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}

export function notifyChannels(config: Config): string[] {
  return config.NOTIFY_CHANNELS.split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
}
