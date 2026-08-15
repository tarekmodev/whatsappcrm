import { ApiException } from '../common/errors/api.exception';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import {
  InvalidTicketCursorError,
  TicketCloseNotPermittedError,
  TicketNotFoundError,
  TicketStatusChangedConcurrentlyError,
  TicketTransitionNotAllowedError,
  UnknownTicketAssigneeError,
} from './tickets.errors';

/**
 * The one place a ticket failure becomes an HTTP answer, mirroring
 * `translateConversationFailure`.
 *
 * Written once rather than per route so the same condition cannot answer 404 on
 * the detail read and 403 on the PATCH — the property `httpStatusForErrorCode`
 * gives inside a code, applied to the layer that chooses the code.
 *
 * **No new error codes.** Every failure here maps onto the taxonomy 0002
 * publishes; inventing one would make `error-codes.ts` something an
 * implementation edits rather than something the contract rules.
 *
 * Two of the mappings are where information leaks if they are got wrong:
 *
 *   * **A ticket the caller may not see is `not_found`, never `forbidden`.**
 *     Another tenant's is already invisible under RLS, and a 403 on a
 *     colleague's would confirm the id names a real ticket somebody is working.
 *   * **A missing `ticket:close` *is* `forbidden`**, and that is not a
 *     contradiction. By the time it is raised the caller has passed the
 *     visibility check, so the resource's existence is not a secret from them —
 *     what is refused is the act, and answering `not_found` would send an agent
 *     hunting for a ticket they are looking at.
 *   * **An assign body naming a stranger is `validation_failed`, not
 *     `not_found`.** The ticket was found; what is wrong is a field of the body,
 *     and a 404 here would read as "the ticket is gone" — see
 *     `UnknownTicketAssigneeError`.
 *
 * Both conflict cases share `conflict`, and deliberately: a refused transition
 * and a lost compare-and-set are the same fact to a client — the row's state
 * refused a well-formed request, and the answer is to refetch. They differ in
 * message, for the same reason `ConversationUnclaimedError` and
 * `ConversationAlreadyClaimedError` do.
 *
 * Anything unrecognised is rethrown untouched: it is a fault, and reporting a
 * database outage as a validation error would hide it.
 */
export function translateTicketFailure(error: unknown): never {
  if (error instanceof TicketNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (
    error instanceof TicketTransitionNotAllowedError ||
    error instanceof TicketStatusChangedConcurrentlyError
  ) {
    throw new ApiException('conflict', error.message);
  }

  if (error instanceof TicketCloseNotPermittedError) {
    throw new ApiException('forbidden', error.message);
  }

  if (error instanceof InvalidTicketCursorError) {
    throw new ApiException('validation_failed', error.message, [
      { path: error.parameter, message: error.message },
    ]);
  }

  if (error instanceof UnknownTicketAssigneeError) {
    throw new ApiException('validation_failed', error.message, [
      { path: error.field, message: error.message },
    ]);
  }

  if (error instanceof TenantNotActiveError) {
    // A deactivated tenant with a session still open (TAR-51). A runtime state
    // an operator created, not a fault — reporting it as 500 would page someone
    // every time a tenant was shut off. Same translation the inbox makes.
    throw new ApiException('forbidden', error.message);
  }

  throw error;
}
