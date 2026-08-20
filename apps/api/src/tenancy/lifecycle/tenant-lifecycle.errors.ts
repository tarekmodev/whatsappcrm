import type { LifecycleTrigger, TenantStatus } from '@whatsappcrm/contracts';

/**
 * The failures the lifecycle engine produces, as typed domain errors rather than
 * `HttpException`s — the same split `tenancy.errors.ts` makes, and for the same
 * reason: a service has no business choosing a status code, and every one of
 * these is also reachable from a queue worker that has no response to send.
 *
 * `lifecycle.http.ts` is the one place they become status codes.
 */
export abstract class TenantLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    // `Error` breaks the prototype chain when a class extending it is
    // down-levelled, which would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * The edge does not exist in `TENANT_STATUS_TRANSITIONS`, or it exists and this
 * trigger is not one of the things that may cause it.
 *
 * One error for both, because both mean the same thing to a caller: the state
 * machine refused, nothing was written, and the tenant is where it was. Which of
 * the two it was is in the message, for the log.
 *
 * `deleted → active` is the case worth naming: it is a data-retention incident
 * rather than a state change, and a tenant that came back from `deleted` would
 * be one whose rows were not actually deleted.
 */
export class InvalidTenantTransitionError extends TenantLifecycleError {
  constructor(
    readonly from: TenantStatus,
    readonly to: TenantStatus,
    readonly trigger: LifecycleTrigger,
    readonly reason: 'edge_not_allowed' | 'trigger_not_allowed',
  ) {
    super(
      reason === 'edge_not_allowed'
        ? `A tenant cannot go from ${from} to ${to}.`
        : `A ${from} → ${to} transition cannot be caused by ${trigger}.`,
    );
  }
}

/**
 * `TenantDeleteInput.confirmSlug` did not match the tenant's own slug.
 *
 * Typing the name of the thing you are destroying is the cheapest possible guard
 * against the one irreversible action in the product, and it is checked
 * server-side because the client having asked nicely is not the check.
 */
export class TenantSlugConfirmationError extends TenantLifecycleError {
  constructor() {
    super('Type the workspace address exactly to confirm.');
  }
}

/**
 * The caller sent a cursor this build cannot read.
 *
 * Reported rather than treated as "no cursor", for the reason
 * `TimestampCursorResult` gives: collapsing the two means a client that
 * corrupted a cursor quietly re-reads page one for ever.
 */
export class InvalidLifecycleCursorError extends TenantLifecycleError {
  constructor() {
    super('That page cursor is not one this API issued.');
  }
}

/**
 * The lifecycle row a notification job names is gone, or was never written.
 *
 * Reachable only if a job outlived the row it points at, which nothing in this
 * design does — `lifecycle_events` is append-only and nothing deletes from it.
 * Said out loud rather than treated as "nothing to send", because the two are
 * different and only one of them is a bug.
 */
export class LifecycleEventNotFoundError extends TenantLifecycleError {
  constructor(readonly eventId: string) {
    super(`No lifecycle event ${eventId}.`);
  }
}
