import type { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import {
  MissingTenantContextError,
  TenantNotActiveError,
  UnscopedModelAccessError,
} from './prisma.errors';

/**
 * The GUC the `tenant_isolation` policies read (TAR-48,
 * `20260810140000_tenant_isolation_rls`). Changing this string here without
 * changing it in the migration silently disables every policy, so it is named
 * once and referenced everywhere.
 */
export const TENANT_GUC = 'app.tenant_id';

/**
 * How that refusal is recognised on the way back. The function raises SQLSTATE
 * `TN001` with `TENANT_NOT_ACTIVE` in the message; both are checked, because
 * Prisma surfaces a driver error's code and its message in different places
 * depending on which path it took, and either one alone identifies it.
 */
const TENANT_NOT_ACTIVE_SQLSTATE = 'TN001';
const TENANT_NOT_ACTIVE_MARKER = 'TENANT_NOT_ACTIVE';

/**
 * How each model is reachable through `TenantPrisma`.
 *
 * Anything absent from this map is `tenant-scoped`: it carries a non-null
 * `tenant_id`, RLS filters it, and the extension needs to do nothing beyond
 * setting the GUC. The four entries are the tables deliberately left without a
 * policy, which is exactly why they need one here instead.
 */
const MODEL_POLICIES = {
  /**
   * `tenants` has no RLS policy and never will — provisioning and host→tenant
   * resolution both read it before any tenant is in scope (TAR-39, data model).
   * The app role therefore holds an unfiltered `SELECT` on it, which
   * `prisma/sql/app-roles.sql` records as known residual exposure and flags for
   * this story. Closed here rather than in the database: reads are narrowed to
   * the tenant in scope, and writes are refused outright — creating, suspending
   * or deleting a tenant is `SystemPrisma`'s job, and the grant denies it
   * anyway (this just turns a bare SQLSTATE 42501 into a message that names the
   * cause).
   */
  Tenant: 'own-row',
  /** Platform-wide product catalogue. Shared by design, and read-only for a tenant. */
  Plan: 'shared-read-only',
  /**
   * Written before the tenant is known, so it carries a nullable `tenant_id`
   * and no policy could apply. The app role is granted nothing on it at all;
   * refusing here means a clear error instead of a permission failure three
   * frames deeper.
   */
  WebhookEvent: 'system-only',
  /**
   * A self-signup before its tenant exists (TAR-440, ADR 0009 decision 3). Same
   * shape as `WebhookEvent` and for the same reason — written before there is a
   * tenant to scope to, so no policy could apply and the app role is granted
   * nothing on it. Refusing here means signup code that reached for the wrong
   * client gets a message naming the cause rather than a permission failure
   * three frames deeper. It runs on `SystemPrisma`.
   */
  TenantSignup: 'system-only',
} as const satisfies Partial<Record<Prisma.ModelName, string>>;

/**
 * Operations that write. Everything else either reads or is a raw statement,
 * which is handled separately because it has no model to apply a policy to.
 */
const WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/** Interactive-transaction options, minus the ones a caller has no business setting. */
export interface TenantTransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * Wraps an un-extended client so that **every** statement it sends is preceded,
 * in the same transaction, by the GUC that TAR-48's RLS policies read.
 *
 * ```sql
 * BEGIN;
 * SELECT set_config('app.tenant_id', assert_tenant_active($1), true);  -- true = transaction-local
 * <the actual query>;
 * COMMIT;
 * ```
 *
 * Four properties make this the mechanism rather than a convenience:
 *
 *   * **Transaction-local.** `set_config(…, true)` reverts when the transaction
 *     ends, so a pooled connection cannot carry one request's tenant into the
 *     next one. A session-level `set_config(…, false)` anywhere in this codebase
 *     would be a cross-tenant leak; there is none, and the integration test
 *     asserts a connection reused across two tenants stays honest.
 *   * **Fail-closed, twice.** No tenant in scope throws here, before anything is
 *     sent. If that check were ever bypassed, the policy predicate evaluates to
 *     NULL and returns zero rows rather than every row.
 *   * **It covers raw SQL.** `$allOperations` at the top level of `query` sees
 *     `$queryRaw` and `$executeRaw` too, which is the half an argument-rewriting
 *     extension cannot reach and the reason RLS is the layer that matters.
 *   * **A deactivated tenant gets nothing** (TAR-51). `assert_tenant_active`
 *     raises unless the tenant in scope is `active`, and Postgres evaluates it
 *     before `set_config`, so the GUC is never set and the statement batched
 *     behind it never runs. The status is read inside the transaction that is
 *     about to run rather than from a cache, so a deactivation takes effect on
 *     the very next statement — there is no window in which a revoked tenant
 *     still reads. The cost is one primary-key lookup inside a round trip that
 *     was already being made.
 *
 * Two things it deliberately does not do. It does not inject `tenantId` into
 * `where`/`data` for the 35 scoped models — RLS already filters them, and the
 * policy predicate uses the same `(tenant_id, …)` index a hand-written filter
 * would. And it does not make batch `$transaction([…])` work: this hook is
 * `async`, so the promises the extended client returns are ordinary promises
 * rather than `PrismaPromise`s. Use `$tenantTransaction` for multi-statement
 * work.
 */
export function withTenantScope(base: PrismaClient, tenantContext: TenantContextService) {
  return base.$extends({
    name: 'tenant-scope',

    client: {
      /**
       * Runs `work` in one interactive transaction with the GUC set once at its
       * start — the right shape for anything that has to be atomic, and cheaper
       * than the per-statement path because the transaction is opened once.
       *
       * The client handed to `work` is the **un-extended** transaction client,
       * on purpose: the GUC is already set for the whole transaction, so
       * re-applying it per statement would nest a transaction inside itself.
       * The consequence to know about is that the `MODEL_POLICIES` above do not
       * apply inside — `tx.tenant.findMany()` is not narrowed to the tenant in
       * scope the way `tenantPrisma.tenant.findMany()` is. RLS still covers
       * every other model. Read `Tenant` outside the transaction, or filter it
       * by hand.
       */
      // `async` so a missing tenant rejects rather than throwing at the call
      // expression: the query path rejects, and one of the two behaving
      // differently is the kind of inconsistency that survives into a `.catch()`
      // chain that silently never runs.
      async $tenantTransaction<T>(
        work: (tx: Prisma.TransactionClient) => Promise<T>,
        options?: TenantTransactionOptions,
      ): Promise<T> {
        const tenantId = tenantContext.tenantId;

        if (tenantId === null) {
          throw new MissingTenantContextError('$tenantTransaction');
        }

        return base
          .$transaction(async (tx) => {
            await setTenantScope(tx, tenantId);
            return work(tx);
          }, options)
          .catch((error: unknown) => {
            throw translateDeactivation(error, tenantId, '$tenantTransaction');
          });
      },
    },

    query: {
      async $allOperations({ model, operation, args, query }) {
        const tenantId = tenantContext.tenantId;

        if (tenantId === null) {
          throw new MissingTenantContextError(operation, model);
        }

        const scopedArgs = applyModelPolicy(model, operation, args, tenantId);

        // One batched transaction, so the GUC and the statement it protects can
        // never end up on different pooled connections.
        const [, result] = await base
          .$transaction([
            setTenantScope(base, tenantId),
            // `query` returns the PrismaPromise for the operation this hook
            // intercepted; the cast only widens its result, which is discarded by
            // the destructuring above and re-typed by Prisma at the call site.
            query(scopedArgs) as Prisma.PrismaPromise<unknown>,
          ])
          .catch((error: unknown) => {
            throw translateDeactivation(error, tenantId, operation, model);
          });

        return result;
      },
    },
  });
}

export type TenantPrisma = ReturnType<typeof withTenantScope>;

/**
 * The one statement that puts a tenant in scope, so the GUC name and the
 * deactivation gate are written once rather than once per call path.
 *
 * `assert_tenant_active` is TAR-51's gate
 * (`20260810150000_tenant_deactivation_guard`): it returns the tenant id when
 * that tenant is `active` and raises otherwise. Postgres evaluates it before
 * `set_config`, so a deactivated tenant never sets the GUC that TAR-48's
 * policies read and therefore matches no rows anywhere.
 *
 * **Schema-qualified deliberately.** Unqualified, it resolves through the
 * connection's `search_path`, and a connection that does not have `public` on
 * its path — a role default, or `options=-csearch_path=…` in the URL, neither
 * of which the Compose stack uses — fails with "function does not exist" on
 * every tenant statement. Fail-closed, but a full outage rather than a refusal.
 * `set_config` needs no qualification: it lives in `pg_catalog`, which is
 * searched first unless it is named explicitly somewhere in the path.
 *
 * Both values are bound as parameters. Interpolating the tenant id into the SQL
 * would be an injection hole reachable from a session claim; the function name
 * is the only thing here that is part of the statement text, and it is written
 * in this one place.
 *
 * Takes the client to run on because the two call paths need different ones:
 * the batched path composes a `PrismaPromise` on the base client to hand to
 * `$transaction([…])`, while `$tenantTransaction` awaits it on the transaction
 * client so the GUC lands inside that transaction rather than beside it.
 */
function setTenantScope(
  client: Pick<Prisma.TransactionClient, '$executeRaw'>,
  tenantId: string,
): Prisma.PrismaPromise<number> {
  return client.$executeRaw`SELECT set_config(${TENANT_GUC}, public.assert_tenant_active(${tenantId}), true)`;
}

/**
 * Turns the database's refusal into the typed error, and leaves everything else
 * exactly as it was.
 *
 * The narrowing matters as much as the translation: reporting an arbitrary
 * database failure as "tenant deactivated" would hide an outage behind a 403,
 * so only a failure carrying the function's own SQLSTATE or marker is
 * translated. Anything else propagates untouched and is logged as the fault it
 * is.
 */
function translateDeactivation(
  error: unknown,
  tenantId: string,
  operation: string,
  model?: string,
): unknown {
  return isTenantNotActive(error) ? new TenantNotActiveError(tenantId, operation, model) : error;
}

/**
 * True when `error` came from `assert_tenant_active`.
 *
 * Prisma reports a driver failure in one of two shapes depending on how it
 * reached the database — `meta.message` on the engine path,
 * `meta.driverAdapterError.cause.originalMessage` on the `@prisma/adapter-pg`
 * path this application uses — and the outer `message` usually quotes one of
 * them. All three are searched, for the same reason
 * `TenantProvisioningService` searches both places for a constraint name: the
 * check must survive a driver change rather than silently stop matching.
 */
function isTenantNotActive(error: unknown): boolean {
  const haystack = describeDatabaseFailure(error);

  return (
    haystack.includes(TENANT_NOT_ACTIVE_MARKER) || haystack.includes(TENANT_NOT_ACTIVE_SQLSTATE)
  );
}

function describeDatabaseFailure(error: unknown): string {
  const record = asRecord(error);

  if (record === undefined) {
    return '';
  }

  const meta = asRecord(record.meta) ?? {};
  const cause = asRecord(asRecord(meta.driverAdapterError)?.cause) ?? {};

  return [
    record.message,
    meta.code,
    meta.message,
    cause.code,
    cause.originalCode,
    cause.originalMessage,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Applies the policy for `model` and returns the arguments to run with.
 * Raw statements arrive with no model — nothing to narrow, and RLS is what
 * protects them.
 */
function applyModelPolicy(
  model: string | undefined,
  operation: string,
  args: unknown,
  tenantId: string,
): unknown {
  if (model === undefined) {
    return args;
  }

  const policy = MODEL_POLICIES[model as keyof typeof MODEL_POLICIES] as
    (typeof MODEL_POLICIES)[keyof typeof MODEL_POLICIES] | undefined;

  switch (policy) {
    case undefined:
      return args;

    case 'system-only':
      throw new UnscopedModelAccessError(
        model,
        operation,
        'this table carries no tenant_id and no RLS policy, and the app role is granted ' +
          'nothing on it — reach it through SystemPrisma',
      );

    case 'shared-read-only':
      if (WRITE_OPERATIONS.has(operation)) {
        throw new UnscopedModelAccessError(
          model,
          operation,
          'this is platform-wide catalogue data shared by every tenant, and a tenant may not write it',
        );
      }
      return args;

    case 'own-row':
      if (WRITE_OPERATIONS.has(operation)) {
        throw new UnscopedModelAccessError(
          model,
          operation,
          'tenant records are written by provisioning and lifecycle flows through SystemPrisma',
        );
      }
      return narrowToOwnRow(args, tenantId);
  }
}

/**
 * Adds `AND: [{ id: tenantId }]` to the query's `where`, which every read
 * operation accepts — including `findUnique`, whose `where` takes extra filters
 * alongside the unique field. Appending to `AND` rather than setting `id`
 * directly means a caller's own `id` filter is intersected with this one and
 * cannot overwrite it: asking for another tenant returns nothing.
 */
function narrowToOwnRow(args: unknown, tenantId: string): unknown {
  const source = (args ?? {}) as { where?: Record<string, unknown> };
  const where = source.where ?? {};
  const existing = where.AND;
  const conjuncts: unknown[] =
    existing === undefined ? [] : Array.isArray(existing) ? (existing as unknown[]) : [existing];

  return { ...source, where: { ...where, AND: [...conjuncts, { id: tenantId }] } };
}
