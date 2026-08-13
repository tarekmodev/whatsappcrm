import { ApiException } from '../common/errors/api.exception';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { InvalidSlaCursorError, SlaAlertNotFoundError, SlaPolicyNotFoundError } from './sla.errors';

/**
 * The one place an SLA failure becomes an HTTP answer.
 *
 * Written once rather than per route so the same condition cannot answer 404 on
 * one and 403 on another. **No new error code**: 0006 checked the published
 * taxonomy against every failure this surface has and found it complete, so
 * nothing here invents one — `error-codes.ts` is something 0002 rules, not
 * something an implementation edits.
 *
 * The mapping that carries a security consequence is the second one: an alert
 * addressed to another principal is `not_found`, never `forbidden`. A 403 would
 * confirm the id names a real alert somebody else was sent, which is the
 * enumeration 0002's security section forbids.
 *
 * Anything unrecognised is rethrown untouched: it is a fault, and reporting a
 * database outage as a validation error would hide it.
 */
export function translateSlaFailure(error: unknown): never {
  if (error instanceof SlaPolicyNotFoundError || error instanceof SlaAlertNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof InvalidSlaCursorError) {
    throw new ApiException('validation_failed', error.message, [
      { path: error.parameter, message: error.message },
    ]);
  }

  if (error instanceof TenantNotActiveError) {
    // A deactivated tenant with a session still open (TAR-51). A runtime state
    // an operator created, not a fault — reporting it as 500 would page someone
    // every time a tenant was shut off.
    throw new ApiException('forbidden', error.message);
  }

  throw error;
}
