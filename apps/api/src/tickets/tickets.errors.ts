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

/**
 * An assign body naming a user or a team this tenant does not have — or a user
 * who has one but cannot take work.
 *
 * `validation_failed` naming the offending field, and **not** `not_found`, which
 * is the answer TAR-374's acceptance criteria asked for. Three reasons, and the
 * third is the one that settles it:
 *
 *   * the resource the caller addressed — the ticket — *was* found, and the
 *     offending id is a field of the body. `UnknownTenantMemberError` makes
 *     exactly this argument for `POST /conversations/{id}/assign`, which is the
 *     same act on the neighbouring resource;
 *   * a 404 on this route is indistinguishable from the ticket itself being
 *     gone, which is the answer the console reacts to by dropping the row and
 *     refetching — the wrong recovery for a stale name in a dropdown;
 *   * `tickets.http.ts` exists so that one condition cannot answer two statuses
 *     on two routes. A stranger's user id is one condition.
 *
 * The two cases are folded — an id in another tenant is invisible under RLS and
 * a suspended user is refused by the same lookup — so the message cannot be used
 * to learn that a UUID names somebody real elsewhere. `field` is what the
 * error's `details` entry points at, so the dialog can highlight the input
 * rather than showing a banner.
 */
export class UnknownTicketAssigneeError extends TicketError {
  constructor(
    readonly field: 'userId' | 'teamId',
    readonly kind: 'user' | 'team',
    readonly id: string,
  ) {
    super(`${id} does not name an active ${kind} in this tenant.`);
  }
}

/**
 * A reassignment with no `reason` — a write that takes work away from somebody
 * and does not say why (TAR-32, ADR 0011 decision 1).
 *
 * `validation_failed` naming the field, and **not** `conflict`: nothing about
 * the row's state refused a well-formed request, a field of the body is
 * missing, and that is what `validation_failed` means everywhere else in this
 * API. The console highlights the textarea from `details[0].path` rather than
 * showing a banner.
 *
 * Raised by the service rather than by the schema because Zod sees the body and
 * the rule is about the row — `ticketAssignRequiresReason` is the published
 * predicate, and the console asks it *before* it submits so this error is the
 * backstop rather than the normal path.
 */
export class TicketReasonRequiredError extends TicketError {
  constructor() {
    super('A reason is required when reassigning a ticket somebody already holds.');
  }
}

/**
 * A caller holding `ticket:handoff` but not `ticket:assign`, making a write the
 * handoff bound refuses (ADR 0011 decision 2).
 *
 * `forbidden`, never `not_found`: by this point the caller has passed `require`
 * and is looking at the ticket, so its existence is no secret from them — what
 * is refused is the act. The same reading `TicketCloseNotPermittedError` gets.
 *
 * Three refusals share the class and differ in message, because they are one
 * fact to a client — this write needs `ticket:assign` — and inventing three
 * error codes for it would make `error-codes.ts` something an implementation
 * edits.
 */
export class TicketHandoffNotPermittedError extends TicketError {
  private constructor(message: string) {
    super(message);
  }

  /** Not theirs to give: the ticket is a colleague's, or a team's. */
  static notHeld(): TicketHandoffNotPermittedError {
    return new TicketHandoffNotPermittedError(
      'You can only hand on a ticket that is assigned to you.',
    );
  }

  /** Parking work on people the caller has nothing to do with. */
  static notATeammate(): TicketHandoffNotPermittedError {
    return new TicketHandoffNotPermittedError(
      'You can only hand a ticket to a teammate or to one of your own teams.',
    );
  }

  /** Abandonment rather than a handoff: it leaves the ticket with nobody. */
  static releasing(): TicketHandoffNotPermittedError {
    return new TicketHandoffNotPermittedError(
      'Releasing a ticket needs the ticket:assign permission. Hand it to somebody instead.',
    );
  }
}

/**
 * An escalation naming a `toUserId` this tenant does not have, one who cannot
 * act, or one who could not read the ticket anyway.
 *
 * `validation_failed` on the field, for `UnknownTicketAssigneeError`'s reasons —
 * the ticket was found and what is wrong is a field of the body — and the three
 * cases are folded into one message so it cannot be used to learn that a UUID
 * names somebody real elsewhere.
 *
 * The `ticket:read_all` half is not decoration: it is what makes the
 * notification safe to send. A recipient who already holds that permission can
 * read the ticket, so telling them about it exposes nothing new (ADR 0006
 * decision 4).
 */
export class UnknownEscalationRecipientError extends TicketError {
  constructor(readonly id: string) {
    super(`${id} does not name an active supervisor or admin in this tenant.`);
  }
}

/**
 * An escalation alert id that names nothing this principal was sent.
 *
 * `not_found` and never `forbidden`, exactly as `SlaAlertNotFoundError` is: a
 * 403 would confirm the id names a real alert somebody else was sent, and every
 * read of this resource is narrowed to the calling principal on top of RLS.
 */
export class EscalationAlertNotFoundError extends TicketError {
  constructor(readonly alertId: string) {
    super('No escalation alert matches that id.');
  }
}

/** A cursor this build cannot act on. `tickets.http.ts` turns it into `validation_failed`. */
export class InvalidTicketCursorError extends TicketError {
  constructor(readonly parameter: string) {
    super('The cursor is not valid. Start from the first page.');
  }
}

/**
 * A deferred ticket carrying no `routing_deferred_since` — the state
 * `tickets_routing_deferred_consistent` exists to make impossible.
 *
 * **Deliberately not translated in `tickets.http.ts`**, so it reaches the caller
 * as a 500. Every other error here describes something a client did; this one
 * says the database's own CHECK is gone or a writer worked around it, and a
 * 4xx would file that under "bad request" and hide it. The flagged queue pages
 * on that column, so the alternative is a `nextCursor` of `null` that claims the
 * page is the whole queue — the one failure a supervisor cannot see.
 */
export class TicketRoutingInconsistentError extends TicketError {
  constructor(readonly ticketId: string) {
    super(
      'A deferred ticket is missing the timestamp the flagged queue pages on. ' +
        'tickets_routing_deferred_consistent should have made this impossible.',
    );
  }
}
