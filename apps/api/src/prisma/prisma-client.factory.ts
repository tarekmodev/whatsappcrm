import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Pool caps, per process. Both clients hold their own `pg` pool, so the
 * connection budget for one API pod is `TENANT_POOL_MAX + SYSTEM_POOL_MAX`.
 *
 * The arithmetic that has to stay true: `pods x 12` must remain under the
 * Postgres `max_connections` of the target instance, minus headroom for
 * migrations, `psql` sessions and the queue workers TAR-41 adds. At Render's
 * smallest managed Postgres (97 connections) that is roughly six pods.
 *
 * The split is deliberately lopsided. `SystemPrisma` serves five call sites
 * (TAR-39, decision 1, rule 1) — provisioning, login, webhook ingest, the
 * sweeper, platform reporting — none of them on the hot path, so two
 * connections is enough and a small cap is also a cheap tripwire: if the system
 * pool saturates, something is using it that should be using `TenantPrisma`.
 */
const TENANT_POOL_MAX = 10;
const SYSTEM_POOL_MAX = 2;

/** Long enough to survive a failover, short enough to fail a request rather than hang it. */
const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Server-side cap on any single statement. A runaway query is cancelled by
 * Postgres instead of holding a pooled connection until the client gives up,
 * which is what turns one slow report into a pod-wide outage. Deliberately
 * generous — reporting queries are legitimately slow — and overridable per
 * statement with `SET LOCAL statement_timeout` inside a transaction.
 */
const STATEMENT_TIMEOUT_MS = 30_000;

/** Idle connections are returned to Postgres so a quiet pod stops holding slots. */
const IDLE_TIMEOUT_MS = 30_000;

export type PrismaClientRole = 'tenant' | 'system';

/**
 * Builds an un-extended Prisma client on the `pg` driver adapter, which Prisma 7
 * requires — there is no built-in engine-managed connection any more.
 *
 * The `connectionString` decides which database **role** the client acts as, and
 * that is the whole isolation model: `whatsappcrm_app` holds neither `SUPERUSER`
 * nor `BYPASSRLS`, so RLS applies to it; `whatsappcrm_system` carries the
 * `system_unrestricted` policy and sees everything. Both roles come from
 * `prisma/sql/app-roles.sql` (TAR-48). Passing the migration/owner URL here
 * would silently disable tenant isolation on a superuser cluster, so the URL is
 * read from validated configuration and never from anything a caller supplies.
 *
 * `application_name` is set so `pg_stat_activity` says which client holds a
 * connection — the first question worth asking when the pool saturates.
 */
export function createPrismaClient(role: PrismaClientRole, connectionString: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    max: role === 'tenant' ? TENANT_POOL_MAX : SYSTEM_POOL_MAX,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: `whatsappcrm-api-${role}`,
  });

  return new PrismaClient({ adapter });
}
