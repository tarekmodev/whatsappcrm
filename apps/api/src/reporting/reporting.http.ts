import { ApiException } from '../common/errors/api.exception';
import { isTenantNotActiveError, tenantInactive } from '../common/errors/tenant-inactive';
import { ReportTeamNotFoundError } from './reporting.errors';

/**
 * The one place a reporting failure becomes an HTTP answer.
 *
 * Written once rather than per route so the same condition cannot answer 404 on
 * the JSON route and 403 on the CSV one — which is the shape of divergence ADR
 * 0010 decision 1 exists to prevent, arriving through the error path instead of
 * the query path.
 *
 * **No new error code.** 0010 checked the published taxonomy against every
 * failure this surface has and found it complete: `validation_failed` for a
 * range the schema refuses, `forbidden` for a caller without `report:read`,
 * `not_found` for an unknown team, and `internal_error` for a report that runs
 * out of statement time. `error-codes.ts` is something 0002 rules, not something
 * an implementation edits.
 *
 * A timed-out report deliberately falls through to the rethrow and lands as a
 * 500. It is a capacity fault on our side rather than something the caller can
 * fix by asking differently — the range is already capped at 366 days — so it
 * takes the generic server code and leaves the detail in the log line with its
 * `requestId`. Ranges timing out routinely is 0010 decision 3's escalation, not
 * a new error code.
 */
export function translateReportingFailure(error: unknown): never {
  if (error instanceof ReportTeamNotFoundError) {
    throw new ApiException('not_found', error.message);
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
