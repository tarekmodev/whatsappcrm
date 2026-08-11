/**
 * The one way deactivation can fail that is the caller's to resolve. A plain
 * domain error, not an `HttpException`: the service has no business choosing a
 * status code, and it is also called from places that have no HTTP response to
 * send. The controller maps it.
 *
 * There is deliberately no error for "already deactivated" — that is a
 * successful no-op, not a failure. See `TenantDeactivationService`.
 */

/**
 * No tenant carries this slug. Reported rather than answered with a silent
 * success, because an operator who mistypes a slug during an incident needs to
 * know the tenant they meant is still running.
 */
export class TenantNotFoundError extends Error {
  constructor(readonly slug: string) {
    super(`No tenant is provisioned with the slug ${slug}.`);
    // `Error` breaks the prototype chain when a subclass is down-levelled,
    // which would make `instanceof` lie in the controller and in a matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}
