import { z } from 'zod';

/**
 * Every environment variable the API reads, in one place. The process refuses to
 * boot if this schema fails — a missing secret is a startup crash, never a
 * `undefined` that surfaces three hours later in production.
 *
 * `.env.example` at the repository root is the human-readable mirror of this
 * schema and must be updated in the same commit whenever a key is added here.
 */
const envShape = z.object({
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
