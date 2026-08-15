import { ApiException } from '../common/errors/api.exception';
import {
  AssignmentRuleNameTakenError,
  AssignmentRuleNotFoundError,
  RuleNeedsTargetError,
  RuleSetChangedError,
  TooManyAssignmentRulesError,
  UnknownRuleReferenceError,
} from './assignment.errors';

/**
 * The one place an assignment-domain failure becomes an HTTP answer, on
 * `people.http.ts`' pattern and for the same reason: written once, so the same
 * condition cannot answer 409 on one route and 400 on another.
 *
 * 0007 adds no error code — `validation_failed`, `not_found` and `conflict`
 * cover every refusal the routing surface has.
 *
 * The one distinction worth reading twice is the split between the first two.
 * A rule the caller cannot see is `not_found`, never `forbidden`, because a 403
 * would confirm the id exists somewhere. A *target* the caller cannot see is
 * `validation_failed` naming the field, not `not_found`, because the missing
 * thing is not the resource being addressed — and RLS means the server cannot
 * tell another tenant's team from a team that never existed anyway.
 *
 * Anything unrecognised is rethrown untouched: it is a fault, and reporting a
 * database outage as a validation error would hide it. `MalformedRuleConditionsError`
 * is deliberately in that group.
 */
export function translateAssignmentFailure(error: unknown): never {
  if (error instanceof AssignmentRuleNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof UnknownRuleReferenceError) {
    throw new ApiException('validation_failed', error.message, [
      { path: error.field, message: error.message },
    ]);
  }

  if (error instanceof RuleNeedsTargetError) {
    throw new ApiException('validation_failed', error.message, [
      { path: 'target', message: error.message },
    ]);
  }

  if (
    error instanceof AssignmentRuleNameTakenError ||
    error instanceof TooManyAssignmentRulesError ||
    error instanceof RuleSetChangedError
  ) {
    throw new ApiException('conflict', error.message);
  }

  throw error;
}
