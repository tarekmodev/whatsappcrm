/**
 * The one way `resolveFallbackAssignment` gives up rather than returning a
 * decision.
 *
 * 0007 decision 5 draws the line and it is worth restating: a **decision** means
 * rotation reached an answer, including the answer "nobody was eligible".
 * Everything else throws, the routing job fails, and BullMQ's retry policy
 * decides what happens next. There is deliberately no error for "no eligible
 * agent" — that is a `no_eligible_agent` decision carrying a reason, because a
 * supervisor has to see it.
 *
 * The failures that are not this one are raised elsewhere and pass through
 * untouched: `MissingTenantContextError` and `TenantNotActiveError` come out of
 * `TenantPrisma` (`src/prisma/prisma.errors.ts`), and a database fault is a
 * database fault.
 */

/**
 * The request names a different tenant from the one in scope.
 *
 * **Not retryable, and not a race.** A `FallbackAssignmentRequest` reaches the
 * resolver from a queue payload, which is unauthenticated input; the worker is
 * required to put `job.data.tenantId` in scope before its first statement
 * (0007, rule 3). If the two disagree, either the caller skipped that step or
 * the payload is forged, and both are bugs rather than transient conditions.
 *
 * Nothing here would actually leak if it were ignored — every predicate in the
 * candidate query uses the tenant in scope, and RLS filters on it regardless, so
 * a forged `tenantId` influences no row. It throws anyway: a value that is
 * silently disregarded is a value the next reader will assume is being honoured.
 */
export class FallbackAssignmentTenantMismatchError extends Error {
  constructor(
    readonly requestedTenantId: string,
    readonly scopedTenantId: string,
  ) {
    super(
      `Fallback assignment was requested for tenant ${requestedTenantId} while tenant ` +
        `${scopedTenantId} is in scope. The routing worker must set tenant context from ` +
        'job.data.tenantId before calling the resolver.',
    );
    // `Error` breaks the prototype chain when down-levelled, which would make
    // `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}
