import { ApiException } from '../common/errors/api.exception';
import {
  InvalidWorkflowCursorError,
  TooManyElapsedTriggerWorkflowsError,
  TooManyWorkflowsError,
  UnknownWorkflowReferenceError,
  WorkflowNameTakenError,
  WorkflowNotFoundError,
  WorkflowReferenceBrokenError,
  WorkflowSetChangedError,
  WorkflowTestTicketNotFoundError,
} from './workflows.errors';

/**
 * The one place a workflow-domain failure becomes an HTTP answer, on
 * `assignment.http.ts`' pattern and for the same reason: written once, so the
 * same condition cannot answer 409 on one route and 400 on another.
 *
 * ## Three distinctions worth reading twice
 *
 *   * **A workflow the caller cannot see is `not_found`, never `forbidden`** — a
 *     403 would confirm the id exists somewhere. Within the tenant everyone
 *     holding `workflow:read` sees every workflow; workflows are tenant
 *     configuration, not assignable records.
 *   * **A *reference* the caller cannot see is `validation_failed` naming the
 *     field**, not `not_found`. The missing thing is not the resource being
 *     addressed, and RLS means the server genuinely cannot tell another tenant's
 *     team from a team that never existed.
 *   * **A reference that *was* valid is `workflow_reference_broken`**, the one
 *     code this story adds. The body is well-formed and the caller changed
 *     nothing — a colleague deleted a tag last week — so the console's next
 *     action is "pick a replacement", not "fix your input". Collapsing it into
 *     `validation_failed` would leave the console string-matching on `message`,
 *     which is the thing `code` exists to prevent.
 *
 * Anything unrecognised is rethrown untouched: it is a fault, and reporting a
 * database outage as a validation error would hide it.
 * `MalformedWorkflowDefinitionError` is deliberately in that group — a stored
 * definition that no longer parses is corruption, not a bad request.
 */
export function translateWorkflowFailure(error: unknown): never {
  if (error instanceof WorkflowNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof WorkflowTestTicketNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof UnknownWorkflowReferenceError) {
    throw new ApiException('validation_failed', error.message, [
      { path: error.field, message: error.message },
    ]);
  }

  if (error instanceof InvalidWorkflowCursorError) {
    throw new ApiException('validation_failed', error.message, [
      { path: error.field, message: error.message },
    ]);
  }

  if (error instanceof WorkflowReferenceBrokenError) {
    // `details` names each broken reference by its path in the definition, which
    // is what lets the console highlight the exact field rather than the rule.
    throw new ApiException(
      'workflow_reference_broken',
      error.message,
      error.broken.map((use) => ({
        path: use.path,
        message: `This ${use.kind} no longer exists.`,
      })),
    );
  }

  if (
    error instanceof WorkflowNameTakenError ||
    error instanceof TooManyWorkflowsError ||
    error instanceof TooManyElapsedTriggerWorkflowsError ||
    error instanceof WorkflowSetChangedError
  ) {
    throw new ApiException('conflict', error.message);
  }

  throw error;
}
