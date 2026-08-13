import type { TicketStatus } from '@whatsappcrm/contracts';

/**
 * The failures the ticket REST surface produces, as typed domain errors rather
 * than `HttpException`s.
 *
 * The same split `conversations.errors.ts` makes, for the same reason: a service
 * has no business choosing a status code, and `tickets.http.ts` is the one place
 * that decides. Anything not listed here reaches the caller as a 500, which is
 * the correct answer for a fault.
 *
 * Distinct from `ticket-linking.errors.ts`, which carries the *queue* path's
 * failures. Those never reach HTTP — nothing about an inbound-message job has a
 * caller to answer — and folding the two would put a status-code decision on a
 * worker that has no response to put it in.
 *
 * **Nothing here ever carries a subject, a message body or a customer's phone
 * number.** These messages are read by agents, logged, and shipped to the error
 * tracker.
 */

export abstract class TicketError extends Error {
  protected constructor(message: string) {
    super(message);
    // `Error` breaks the prototype chain when a class extending it is
    // down-levelled, which would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * The ticket does not exist, is in another tenant, or is one this principal may
 * not see. **All three are the same error on purpose**, exactly as
 * `ConversationNotFoundError` is: a `forbidden` for the third would confirm the
 * id names a real ticket a colleague is working. RLS already makes the first two
 * indistinguishable; this keeps the third with them.
 *
 * Note that tickets use the *narrow* visibility rule (`isVisible`), not the
 * shared inbox's `isVisibleOrUnclaimed`. An unassigned ticket is triaged work
 * rather than a customer waiting in a shared pool, so it stays invisible without
 * `ticket:read_all` — `visibility.ts` argues the difference where the two
 * functions sit beside each other.
 */
export class TicketNotFoundError extends TicketError {
  constructor(readonly ticketId: string) {
    super('No ticket matches that id.');
  }
}

/**
 * A status move the transition table refuses (0006, §2) — every attempt to
 * re-activate a `resolved` or `closed` ticket.
 *
 * `conflict` rather than `validation_failed`: the body is well-formed and names
 * a real status, and what refuses it is the state of the row. The same argument
 * `ConversationUnclaimedError` makes.
 *
 * The message names the current status so the console can say what the ticket
 * is rather than only what it cannot become. It carries no reopen advice,
 * because at v1 there is nothing to advise: a customer writing back after
 * resolution gets a **new** ticket (0003, open question 1).
 */
export class TicketTransitionNotAllowedError extends TicketError {
  constructor(
    readonly ticketId: string,
    readonly from: TicketStatus,
    readonly to: TicketStatus,
  ) {
    super(`A ${from} ticket cannot be moved to ${to}.`);
  }
}

/**
 * The compare-and-set matched no row: the ticket's status moved between this
 * request reading it and its update landing.
 *
 * The realistic cause is the one this story exists around — the customer replied
 * and `TicketLinkerService` reopened the ticket from `pending` to `open` while
 * the agent was resolving it. **Deliberately not retried against the new
 * status** (0006, §4): re-applying "resolve" from `open` would satisfy the click
 * and hide the fact that the customer just wrote, which is the one thing the
 * agent needs to know before resolving. `conflict` sends the console to a
 * refetch, the new message appears, and the agent decides again.
 *
 * The message names the status the request was made against rather than the one
 * the row now holds. The row is re-read by the console's refetch a moment later,
 * and reading it here to name it would be a second query answering a question
 * that has already changed again.
 */
export class TicketStatusChangedConcurrentlyError extends TicketError {
  constructor(
    readonly ticketId: string,
    readonly expected: TicketStatus,
  ) {
    super(
      `This ticket is no longer ${expected} — somebody or something changed it while you were ` +
        'working. Reload it and try again.',
    );
  }
}

/**
 * A transition into `resolved` or `closed` by a principal holding
 * `ticket:update` but not `ticket:close` (0004, 0006 §7).
 *
 * `forbidden` rather than `not_found`, and it is the one place in this module
 * where those two diverge: the caller has already passed the visibility check,
 * so the ticket's existence is not a secret from them. What they may not do is
 * finish it.
 *
 * Checked in the service rather than in the guard because the guard is per-route
 * and this is per-body — the same `PATCH` that closes a ticket also
 * re-prioritises one, and only the request says which.
 */
export class TicketCloseNotPermittedError extends TicketError {
  constructor(readonly to: TicketStatus) {
    super(`Marking a ticket ${to} needs the ticket:close permission.`);
  }
}

/** A cursor this build cannot act on. `tickets.http.ts` turns it into `validation_failed`. */
export class InvalidTicketCursorError extends TicketError {
  constructor(readonly parameter: string) {
    super('The cursor is not valid. Start from the first page.');
  }
}
