/**
 * The ways `TenantPrisma` refuses a query rather than answering it. All of them
 * are plain `Error`s and not `HttpException`s — the data layer has no business
 * choosing a status code — but they fall into two families, and the difference
 * decides how a filter should report them.
 *
 * `TenantPrismaError` (below) is a **bug in the calling code**: a query with no
 * tenant resolved, or a model reached through the wrong client. TAR-41's
 * exception filter maps those to `internal_error`; anything that could
 * legitimately reach an end user should have been caught by a guard long before
 * the query.
 *
 * `TenantNotActiveError` is not a bug. It is a deactivated tenant still holding
 * a session, which is a state an operator deliberately created, and it belongs
 * in front of the caller as a 403 rather than in an error tracker as a fault.
 */

/** Discriminator so a filter can match the family without an `instanceof` chain. */
export const TENANT_PRISMA_ERROR = 'TenantPrismaError';

abstract class TenantPrismaError extends Error {
  readonly kind = TENANT_PRISMA_ERROR;

  protected constructor(message: string) {
    super(message);
    // `Error` breaks the prototype chain when a class extending it is
    // down-levelled, which would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Thrown when a query reaches `TenantPrisma` with no tenant in the ambient
 * context. **This is the fail-closed guarantee in the client**: the query is
 * never sent, so there is no window in which an un-scoped statement could run.
 *
 * The database is the second line and would return zero rows anyway (TAR-48's
 * `tenant_isolation` policy), but zero rows is indistinguishable from an empty
 * table — silent, and therefore useless as a signal that a code path forgot to
 * resolve its tenant. Failing here makes it loud.
 */
export class MissingTenantContextError extends TenantPrismaError {
  constructor(
    readonly operation: string,
    readonly model?: string,
  ) {
    super(
      `TenantPrisma refused ${describeTarget(model, operation)}: no tenant in scope. ` +
        'Resolve the tenant first (AuthGuard for HTTP, the job payload for a worker), ' +
        'or use SystemPrisma if this really is a cross-tenant operation.',
    );
  }
}

/**
 * Thrown when a model that carries no `tenant_id` — and therefore no RLS policy
 * to protect it — is reached through `TenantPrisma` in a way the client cannot
 * scope. See `MODEL_POLICIES` in `tenant-scope.extension.ts` for the three
 * models this covers and why each is treated the way it is.
 */
export class UnscopedModelAccessError extends TenantPrismaError {
  constructor(
    readonly model: string,
    readonly operation: string,
    reason: string,
  ) {
    super(`TenantPrisma refused ${describeTarget(model, operation)}: ${reason}.`);
  }
}

/** Discriminator for the family above, matched by the same filter. */
export const TENANT_NOT_ACTIVE_ERROR = 'TenantNotActiveError';

/**
 * Thrown when the tenant in scope is not `active` — deactivated by TAR-51's
 * flow, still being provisioned, or closed. The refusal comes from
 * `assert_tenant_active` in the database
 * (`20260810150000_tenant_deactivation_guard`), so it applies to every
 * statement `TenantPrisma` sends, including raw SQL, and it is in force from
 * the instant the deactivation commits.
 *
 * Deliberately **not** part of the `TenantPrismaError` family: this is a
 * legitimate runtime state rather than a coding mistake, and a filter that
 * reported it as `internal_error` would page somebody every time an operator
 * deactivated a tenant with a session still open. It maps to `forbidden`; the
 * caller is told the tenant is deactivated and nothing else.
 */
export class TenantNotActiveError extends Error {
  readonly kind = TENANT_NOT_ACTIVE_ERROR;

  constructor(
    readonly tenantId: string,
    readonly operation: string,
    readonly model?: string,
  ) {
    super(
      `TenantPrisma refused ${describeTarget(model, operation)}: tenant ${tenantId} is not active. ` +
        'Its data is retained and reachable through SystemPrisma; a tenant-scoped path may not ' +
        'read or write it until the tenant is reactivated.',
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

function describeTarget(model: string | undefined, operation: string): string {
  return model === undefined ? `${operation}()` : `${model}.${operation}()`;
}
