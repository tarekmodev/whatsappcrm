import { ApiException } from '../common/errors/api.exception';
import { isTenantNotActiveError, tenantInactive } from '../common/errors/tenant-inactive';
import { InvalidNotificationCursorError, NotificationNotFoundError } from './notifications.errors';

/**
 * The one place a notifications failure becomes an HTTP answer.
 *
 * Written once rather than per route so the same condition cannot answer 404 on
 * one and 403 on another. **No new error code**: every failure this surface has
 * is already in the published taxonomy, and `error-codes.ts` is something 0002
 * rules rather than something an implementation edits.
 *
 * The mapping that carries a security consequence is the first: a notification
 * addressed to another principal is `not_found`, never `forbidden`. A 403 would
 * confirm the id names a real notification somebody else was sent, which is the
 * enumeration 0002's security section forbids.
 *
 * Anything unrecognised is rethrown untouched: it is a fault, and reporting a
 * database outage as a validation error would hide it.
 */
export function translateNotificationFailure(error: unknown): never {
  if (error instanceof NotificationNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof InvalidNotificationCursorError) {
    throw new ApiException('validation_failed', error.message, [
      { path: error.parameter, message: error.message },
    ]);
  }

  if (isTenantNotActiveError(error)) {
    // A deactivated tenant with a session still open (TAR-51). A runtime state
    // an operator created, not a fault — reporting it as 500 would page someone
    // every time a tenant was shut off. The error's own message names the data
    // layer and the tenant id, so it never becomes the body (TAR-539).
    throw tenantInactive();
  }

  throw error;
}
