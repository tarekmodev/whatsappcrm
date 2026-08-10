import { z } from 'zod';

/**
 * Every environment variable the API reads, in one place. The process refuses to
 * boot if this schema fails — a missing secret is a startup crash, never a
 * `undefined` that surfaces three hours later in production.
 *
 * `.env.example` at the repository root is the human-readable mirror of this
 * schema and must be updated in the same commit whenever a key is added here.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  /** Origin of the Next.js app, used for the CORS allow-list. */
  WEB_ORIGIN: z.string().min(1).default('http://localhost:3000'),

  /** Injected by the deployment target; surfaced on the health endpoint. */
  APP_VERSION: z.string().min(1).default('0.0.0'),

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
});

export type Env = z.infer<typeof envSchema>;
