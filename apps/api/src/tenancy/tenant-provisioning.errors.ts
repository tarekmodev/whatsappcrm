/**
 * The ways provisioning can fail that are the caller's to resolve. Plain domain
 * errors, not `HttpException`s: the service has no business choosing a status
 * code, and it is also called from places that have no HTTP response to send.
 * The controller maps them.
 *
 * Anything not listed here — the database being unreachable, a constraint
 * nobody anticipated — is a fault, and is left to propagate untranslated so it
 * is logged as one instead of being reported to an operator as their mistake.
 */

/**
 * The platform hostname a slug maps to is already claimed by a *different*
 * tenant, so provisioning would either steal that host or leave the new tenant
 * unreachable. Neither is acceptable, so the whole operation is refused and
 * nothing is written.
 *
 * Reachable in practice when a tenant registered the same name as a custom
 * domain (TAR-29) before anyone provisioned the slug that derives from it.
 */
export class PlatformHostnameTakenError extends Error {
  constructor(readonly hostname: string) {
    super(
      `The platform hostname ${hostname} is already claimed by another tenant. ` +
        'Provision this tenant under a different slug, or release the hostname first.',
    );
    // `Error` breaks the prototype chain when a subclass is down-levelled,
    // which would make `instanceof` lie in the controller and in a matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * The slug was inserted by something else between this transaction reading it
 * and writing it — which the advisory lock rules out for two concurrent calls
 * to this service, so in practice it means a write from outside it.
 *
 * Reported rather than resolved: returning the row that won the race would mean
 * reporting a tenant this call did not provision and cannot vouch for. A retry
 * finds it through the normal idempotent path and answers `200`.
 */
export class TenantSlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(
      `The slug ${slug} was provisioned concurrently by another writer. ` +
        'Retry: the retry will find that tenant and report it as already provisioned.',
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}
