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
