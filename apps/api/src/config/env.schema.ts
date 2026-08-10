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
});

export type Env = z.infer<typeof envSchema>;

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
