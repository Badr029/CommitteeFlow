import { z } from 'zod';

/**
 * Environment parsing.
 *
 * Every secret CommitteeFlow needs is backend-only (spec §63): nothing here is
 * ever handed to the React bundle. Parsing happens once, at process start, so a
 * misconfigured deployment fails immediately instead of at the first request.
 */

const bool = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())));

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? fallback : Number(value)))
    .pipe(z.number().int());

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: int(0),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: int(10),
  DB_IDLE_TIMEOUT_MS: int(30_000),
  DB_CONNECTION_TIMEOUT_MS: int(5_000),

  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  SESSION_NAME: z.string().default('committeeflow.sid'),
  SESSION_TTL_HOURS: int(12),
  REMEMBER_ME_TTL_DAYS: int(30).pipe(z.number().min(1).max(365)),
  COOKIE_SECURE: bool.default(false),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  LOGIN_RATE_LIMIT_WINDOW_MINUTES: int(15),
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS: int(10),
  WRITE_RATE_LIMIT_WINDOW_MINUTES: int(1),
  WRITE_RATE_LIMIT_MAX: int(60),

  SMTP_HOST: optionalString,
  SMTP_PORT: int(587),
  SMTP_SECURE: bool.default(false),
  SMTP_USERNAME: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_FROM: z.string().default('CommitteeFlow <committeeflow@example.com>'),
  APP_PUBLIC_URL: z.string().default('http://localhost:4000'),
  APP_TIME_ZONE: z.string().default('Africa/Cairo'),

  OUTBOX_WORKER_ENABLED: bool.default(true),
  OUTBOX_POLL_INTERVAL_MS: int(15_000),
  OUTBOX_BATCH_SIZE: int(100).pipe(z.number().min(1).max(100)),
  OUTBOX_MAX_ATTEMPTS: int(6).pipe(z.number().min(1).max(20)),
  OUTBOX_RECIPIENT_BATCH_SIZE: int(50).pipe(z.number().min(1).max(100)),
  SMTP_SEND_TIMEOUT_MS: int(30_000).pipe(z.number().min(100).max(120_000)),
  OUTBOX_RUN_BUDGET_MS: int(50_000).pipe(z.number().min(1000).max(240_000)),
  OUTBOX_LEASE_SECONDS: int(120).pipe(z.number().min(1).max(600)),
  OUTBOX_AMBIGUOUS_RETRY_SECONDS: int(900).pipe(z.number().min(60).max(86400)),
  OUTBOX_PARENT_CONCURRENCY: int(2).pipe(z.number().min(1).max(5)),
  OUTBOX_CHILD_CONCURRENCY: int(3).pipe(z.number().min(1).max(10)),

  CLIENT_DIST_PATH: optionalString,
}).refine((config) => config.OUTBOX_LEASE_SECONDS * 1000 > config.SMTP_SEND_TIMEOUT_MS + 10_000,
  { message: 'OUTBOX_LEASE_SECONDS must exceed SMTP_SEND_TIMEOUT_MS by more than 10 seconds' })
  .refine((config) => config.OUTBOX_RUN_BUDGET_MS > config.SMTP_SEND_TIMEOUT_MS + 5_000,
    { message: 'OUTBOX_RUN_BUDGET_MS must exceed SMTP_SEND_TIMEOUT_MS by more than 5 seconds' });

export type AppEnv = z.infer<typeof envSchema>;

function parseEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

let cached: AppEnv | undefined;

/** Parsed process environment. Cached so validation runs exactly once. */
export function env(): AppEnv {
  cached ??= parseEnv();
  return cached;
}

/** Test seam — lets suites build a config object without touching process.env. */
export function parseEnvFrom(source: NodeJS.ProcessEnv): AppEnv {
  return parseEnv(source);
}

export const isProduction = () => env().NODE_ENV === 'production';
export const isTest = () => env().NODE_ENV === 'test';
