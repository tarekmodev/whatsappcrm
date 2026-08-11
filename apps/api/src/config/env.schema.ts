import { z } from 'zod';

/**
 * Every environment variable the API reads, in one place. The process refuses to
 * boot if this schema fails — a missing secret is a startup crash, never a
 * `undefined` that surfaces three hours later in production.
 *
 * `.env.example` at the repository root is the human-readable mirror of this
 * schema and must be updated in the same commit whenever a key is added here.
 */
/** Pino's level names, in the order pino orders them. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/**
 * Which provisioned environment this process is. Distinct from `NODE_ENV`, which
 * only says how the code was built: all three deployed environments run
 * `NODE_ENV=production`, and telling them apart is what makes a log line, a
 * metric and a Sentry issue attributable.
 */
export const DEPLOY_ENVS = ['local', 'development', 'staging', 'production'] as const;

const envShape = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  /** Origin of the Next.js app, used for the CORS allow-list. */
  WEB_ORIGIN: z.string().min(1).default('http://localhost:3000'),

  /** Injected by the deployment target; surfaced on the health endpoint. */
  APP_VERSION: z.string().min(1).default('0.0.0'),

  /** Names the provisioned environment. Stamped on every log line and Sentry event. */
  DEPLOY_ENV: z.enum(DEPLOY_ENVS).default('local'),

  // ---------------------------------------------------------------------------
  // Database. Two URLs, because the isolation model is two database roles
  // (TAR-48, `prisma/sql/app-roles.sql`) and which role a client connects as is
  // the whole guarantee. Required: the API has a data layer now, and a process
  // that boots without one only fails later and less clearly.
  //
  // Neither may point at the migration owner. On a managed instance the owner
  // is usually a superuser, and a superuser skips row-level security entirely —
  // every tenant would see every row, with nothing in the logs to say so.
  // ---------------------------------------------------------------------------

  /** `TenantPrisma`, as `whatsappcrm_app`: subject to RLS, holds no BYPASSRLS. */
  APP_DATABASE_URL: z.string().min(1),
  /** `SystemPrisma`, as `whatsappcrm_system`: reads and writes across tenants. */
  SYSTEM_DATABASE_URL: z.string().min(1),

  // ---------------------------------------------------------------------------
  // Tenancy (TAR-19)
  // ---------------------------------------------------------------------------

  /**
   * The zone every tenant's platform subdomain is issued under, so a tenant with
   * slug `acme` is reachable at `acme.<PLATFORM_DOMAIN>`. Custom domains (TAR-29)
   * are added alongside it, never instead of it: the platform subdomain is the
   * host that is guaranteed to work while a customer's DNS is still propagating.
   */
  PLATFORM_DOMAIN: z.string().min(1).default('app.localhost'),

  /**
   * Bearer credential for `/api/v1/admin/*`. Optional here and **absent means
   * the whole admin surface refuses every request** — an environment that has
   * not been given a token cannot provision tenants, which is the safe default
   * for a route that creates them.
   *
   * 32 characters is the floor for something compared against by an
   * unauthenticated caller. Generate with `openssl rand -base64 48`; it is a
   * secret and belongs in the platform's secret store.
   *
   * Placeholder by design: it authenticates *the platform operator*, who is not
   * a tenant user and therefore outside the session and RBAC model TAR-35 and
   * TAR-22 build. Replace it with a real platform-admin identity when one
   * exists — the guard is the only thing that has to change.
   */
  PLATFORM_ADMIN_TOKEN: z.string().min(32).optional(),

  // ---------------------------------------------------------------------------
  // Access control (TAR-22)
  // ---------------------------------------------------------------------------

  /**
   * ⚠️ **INTERIM — REMOVE WHEN TAR-35 LANDS.**
   *
   * Binds `StubPrincipalSource` instead of the session-backed one, so the
   * permission matrix and the role-scoped queries can be built and tested before
   * there is a session to read a role from. It stubs *the source of the
   * principal*, never the guard: `PermissionGuard` and the visibility predicate
   * run identically either way.
   *
   * Two kill switches, mirroring the console's (`NEXT_PUBLIC_ENABLE_ROLE_STUB`):
   * off by default, and the refinement at the bottom of this file refuses to
   * *boot* when it is on under `NODE_ENV=production`. Failing at startup rather
   * than per request is what stops a misconfigured deploy serving a single
   * stubbed call.
   *
   * Left as the literal string rather than transformed to a boolean:
   * `ConfigService.get` can answer from `process.env` as well as from the
   * validated object, so a reader comparing against `true` would sometimes see
   * the string `'true'` and quietly treat the switch as off — a kill switch
   * that fails open in one of its two read paths. `AUTH_STUB_ON` is the one
   * spelling every reader compares against.
   */
  AUTH_STUB_ENABLED: z.enum(['true', 'false']).default('false'),

  // ---------------------------------------------------------------------------
  // WhatsApp webhook ingestion (TAR-20)
  //
  // One Meta app serves every tenant, so both secrets below are platform-level
  // rather than per-tenant: tenant routing is `phone_number_id` →
  // `whatsapp_accounts` (TAR-39, webhook ingestion), not a per-tenant secret.
  // ---------------------------------------------------------------------------

  /**
   * The Meta app secret. `X-Hub-Signature-256` is HMAC-SHA256 of the **raw**
   * request body under this key, and that signature is the only thing standing
   * between an unauthenticated public route and the inbox.
   *
   * Optional here and **absent means every inbound webhook is rejected**, on the
   * same reasoning as `PLATFORM_ADMIN_TOKEN`: an environment that was never
   * given the secret must fail closed rather than accept unsigned payloads.
   * Requiring it outright would instead stop the API booting everywhere the
   * channel is not configured, which trades a local refusal for a global outage.
   */
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),

  /**
   * The token echoed back to Meta during the `GET` verification handshake.
   * Absent means the handshake always answers 403 — the same fail-closed
   * default, and it is only ever read once, when the webhook URL is registered.
   */
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(1).optional(),

  /**
   * How long a stored event may sit in `received` or `processing` before the
   * sweeper treats it as stuck and re-enqueues it. Well under the five minutes
   * TAR-39 says should page someone, so recovery is attempted before an alert
   * fires.
   */
  WEBHOOK_STUCK_AFTER_MS: z.coerce.number().int().min(1_000).default(60_000),

  /** How often the sweeper runs. */
  WEBHOOK_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),

  /**
   * Processing attempts a stored event gets before it is parked `failed`. It is
   * parked, never dropped: a failed row stays queryable and re-runnable.
   */
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  // ---------------------------------------------------------------------------
  // WhatsApp Cloud API (TAR-20)
  // ---------------------------------------------------------------------------

  /**
   * AES-256-GCM key for the per-WABA access token, base64-encoded — 32 bytes,
   * which `openssl rand -base64 32` produces.
   *
   * Optional here and **absent means every WhatsApp connection and every send is
   * refused**, on the same reasoning as `PLATFORM_ADMIN_TOKEN`: an environment
   * that was never given a key must not fall back to storing the most sensitive
   * credential in the schema in clear text. Requiring it outright would instead
   * stop the API booting in every environment that does not use the channel,
   * which trades a loud, local failure for a global one.
   *
   * It is a key, not a password, so it is checked for length rather than
   * strength — 32 bytes from a CSPRNG, held in the platform's secret store.
   * Rotating it needs the tokens re-encrypted; see `access-token.cipher.ts`,
   * whose payloads carry a version tag for exactly that reason.
   */
  WHATSAPP_TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine(isBase64EncodedKey, 'Must be 32 bytes of base64 (openssl rand -base64 32)')
    .optional(),

  /**
   * Meta's Graph API origin. Configurable so tests and a local stub can point
   * the client somewhere else; there is no other reason to change it.
   */
  META_GRAPH_API_BASE_URL: z.url().default('https://graph.facebook.com'),

  /**
   * The Graph API version every request is issued against. Pinned rather than
   * floating: Meta deprecates versions on a published schedule, and a silent
   * bump is how a response shape changes underneath a parser.
   */
  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'Must look like `v23.0`')
    .default('v23.0'),

  /**
   * Per-request timeout for a Graph API call. Every outbound call has one — an
   * unbounded wait on Meta becomes an unbounded wait on a queue worker.
   */
  META_GRAPH_API_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),

  // ---------------------------------------------------------------------------
  // Infrastructure. Optional at scaffold time so the API boots with no backing
  // services. TAR-41 provisions these and promotes them to required.
  // ---------------------------------------------------------------------------

  /**
   * The migration owner's connection, read by the Prisma CLI through
   * `prisma.config.mjs` — never by the running API. Declared here so the
   * schema stays the one place a complete environment is described.
   */
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),

  // ---------------------------------------------------------------------------
  // Observability (TAR-41)
  // ---------------------------------------------------------------------------

  /** `silent` exists for the test suite; every deployed environment sets a real level. */
  LOG_LEVEL: z.enum([...LOG_LEVELS, 'silent']).default('info'),

  /**
   * Human-readable log output. Never enable this in a deployed environment — the
   * log collector parses JSON.
   */
  LOG_PRETTY: z.stringbool().default(false),

  /** A request at or above this duration is logged at `warn` and flagged `slow`. */
  SLOW_REQUEST_THRESHOLD_MS: z.coerce.number().int().positive().default(1_000),

  /** Upper bound on a single readiness probe, so a hung dependency cannot hang the probe. */
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),

  /** Absent in local development: the SDK then no-ops rather than buffering events. */
  SENTRY_DSN: z.url().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
});

/**
 * The one cross-key rule, and the reason this file exports a refined schema
 * rather than the plain object: a fabricated principal must never be reachable
 * in production, whatever `AUTH_STUB_ENABLED` says.
 *
 * Enforced here rather than in the guard so the process **refuses to boot**. A
 * per-request check would let a misconfigured deploy come up healthy, pass its
 * readiness probe and take traffic, and only refuse the requests that happened
 * to reach the stubbed path. `validateEnv` runs while `ConfigModule` is
 * initialising, which is before a single route is mapped.
 */
/** The only value that turns the interim role stub on. */
export const AUTH_STUB_ON = 'true';

export const envSchema = envShape.superRefine((env, ctx) => {
  // TAR-41: every deployed environment runs NODE_ENV=production, and a service
  // that boots pointing at no queue looks healthy right up until the first job.
  if (env.NODE_ENV === 'production' && !env.REDIS_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['REDIS_URL'],
      message: 'is required when NODE_ENV=production',
    });
  }

  if (env.AUTH_STUB_ENABLED === AUTH_STUB_ON && env.NODE_ENV === 'production') {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_STUB_ENABLED'],
      message:
        'must not be enabled when NODE_ENV=production — the interim role stub fabricates a ' +
        'principal and is for local development and tests only. Wire TAR-35 sessions instead.',
    });
  }
});

export type Env = z.infer<typeof envSchema>;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type DeployEnv = (typeof DEPLOY_ENVS)[number];

/** The key length AES-256 requires, in bytes. */
export const WHATSAPP_TOKEN_KEY_BYTES = 32;

/**
 * True when `value` is base64 that decodes to exactly `WHATSAPP_TOKEN_KEY_BYTES`.
 *
 * The round-trip is what makes this a real check: `Buffer.from(…, 'base64')`
 * ignores every character outside the alphabet rather than failing, so a
 * truncated or hand-edited value would otherwise decode to something shorter and
 * be caught only by `createCipheriv` at first use — in production, on the first
 * connection attempt.
 */
function isBase64EncodedKey(value: string): boolean {
  const decoded = Buffer.from(value, 'base64');

  return decoded.length === WHATSAPP_TOKEN_KEY_BYTES && decoded.toString('base64') === value;
}
