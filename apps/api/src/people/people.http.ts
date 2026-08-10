import { ApiException } from '../common/errors/api.exception';
import {
  EmailAlreadyRegisteredError,
  LastAdminRequiredError,
  RoleAssignmentNotPermittedError,
  RoleEscalationError,
  SelfRoleChangeError,
  TeamNameTakenError,
  TeamNotFoundError,
  UnknownReferenceError,
  UserHasHistoryError,
  UserNotFoundError,
} from './people.errors';

/**
 * The one place a people-domain failure becomes an HTTP answer.
 *
 * Written once rather than per controller so the same condition cannot answer
 * 403 on one route and 409 on another — the property the shared
 * `httpStatusForErrorCode` table exists to give, applied at the layer above it.
 *
 * Two choices worth stating, because they are where RBAC information leaks:
 *
 *   * **A record the caller may not see is `not_found`, never `forbidden`.**
 *     Another tenant's user is already invisible — RLS returns nothing and the
 *     service raises `UserNotFoundError` — and a 403 there would confirm the id
 *     exists somewhere.
 *   * **`forbidden` is only for a missing permission on something the caller can
 *     already see.** Their own colleague's row, which they may read but not
 *     promote.
 *
 * Anything unrecognised is rethrown untouched: it is a fault, and reporting a
 * database outage as a validation error would hide it.
 */
export function translatePeopleFailure(error: unknown): never {
  if (error instanceof UserNotFoundError || error instanceof TeamNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof UnknownReferenceError) {
    throw new ApiException(
      'validation_failed',
      error.message,
      error.ids.map((id) => ({ path: 'id', message: `${id} is not in this tenant.` })),
    );
  }

  if (
    error instanceof SelfRoleChangeError ||
    error instanceof RoleEscalationError ||
    error instanceof RoleAssignmentNotPermittedError
  ) {
    throw new ApiException('forbidden', error.message);
  }

  if (error instanceof LastAdminRequiredError) {
    throw new ApiException('last_admin_required', error.message);
  }

  if (
    error instanceof EmailAlreadyRegisteredError ||
    error instanceof TeamNameTakenError ||
    error instanceof UserHasHistoryError
  ) {
    throw new ApiException('conflict', error.message);
  }

  throw error;
}
