/**
 * The two ways `TenantPrisma` refuses a query outright, before it reaches
 * Postgres. Both are bugs in the calling code rather than user errors, so they
 * are plain `Error`s and not `HttpException`s — the data layer has no business
 * choosing a status code. TAR-41's exception filter maps them to
 * `internal_error`; anything that could legitimately reach an end user should
 * have been caught by a guard long before the query.
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

function describeTarget(model: string | undefined, operation: string): string {
  return model === undefined ? `${operation}()` : `${model}.${operation}()`;
}
