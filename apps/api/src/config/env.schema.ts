import { z } from 'zod';

/** Pino's level names, in the order pino orders them. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/**
 * Which provisioned environment this process is. Distinct from `NODE_ENV`, which
 * only says how the code was built: all three deployed environments run
 * `NODE_ENV=production`, and telling them apart is what makes a log line, a
 * metric and a Sentry issue attributable.
 */
export const DEPLOY_ENVS = ['local', 'development', 'staging', 'production'] as const;

/**
 * Every environment variable the API reads, in one place. The process refuses to
 * boot if this schema fails — a missing secret is a startup crash, never a
 * `undefined` that surfaces three hours later in production.
 *
 * `.env.example` at the repository root is the human-readable mirror of this
 * schema and must be updated in the same commit whenever a key is added here.
 *
 * Third-party credentials (WhatsApp Cloud API, Polar.sh) are deliberately absent:
 * no code reads them yet, and a validated schema that lists keys nothing consumes
 * goes stale immediately. They are provisioned per environment as secrets in
 * `render.yaml` and documented in `.env.example`; the story that first reads one
 * (TAR-35, TAR-37) adds it here and makes it required.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),

    /** Origin of the Next.js app, used for the CORS allow-list. */
    WEB_ORIGIN: z.string().min(1).default('http://localhost:3000'),

    /** Injected by the deployment target; surfaced on the health endpoint. */
    APP_VERSION: z.string().min(1).default('0.0.0'),

    /** Names the provisioned environment. Stamped on every log line and Sentry event. */
    DEPLOY_ENV: z.enum(DEPLOY_ENVS).default('local'),

    // ---------------------------------------------------------------------------
    // Infrastructure. Required in production — which is every deployed
    // environment — so a service can never boot pointing at nothing. Optional
    // locally and under test so the API still runs with no backing services.
    // ---------------------------------------------------------------------------
    DATABASE_URL: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).optional(),

    // ---------------------------------------------------------------------------
    // Observability
    // ---------------------------------------------------------------------------
    /** `silent` exists for the test suite; every deployed environment sets a real level. */
    LOG_LEVEL: z.enum([...LOG_LEVELS, 'silent']).default('info'),

    /** Human-readable log output. Never enable this in a deployed environment — the
     * log collector parses JSON. */
    LOG_PRETTY: z.stringbool().default(false),

    /** A request at or above this duration is logged at `warn` and flagged `slow`. */
    SLOW_REQUEST_THRESHOLD_MS: z.coerce.number().int().positive().default(1_000),

    /** Upper bound on a single readiness probe, so a hung dependency cannot hang the probe. */
    HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),

    /** Absent in local development: the SDK then no-ops rather than buffering events. */
    SENTRY_DSN: z.url().optional(),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') {
      return;
    }

    for (const key of ['DATABASE_URL', 'REDIS_URL'] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'is required when NODE_ENV=production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type DeployEnv = (typeof DEPLOY_ENVS)[number];
