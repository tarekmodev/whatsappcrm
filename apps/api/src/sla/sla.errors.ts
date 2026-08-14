/**
 * The failures the SLA surface produces, as typed domain errors rather than
 * `HttpException`s.
 *
 * The same split `conversations.errors.ts` makes, for the same reason: a service
 * has no business choosing a status code, and `sla.http.ts` is the one place
 * that decides. Anything not listed here reaches the caller as a 500, which is
 * the correct answer for a fault.
 */

export abstract class SlaError extends Error {
  protected constructor(message: string) {
    super(message);
    // `Error` breaks the prototype chain when a class extending it is
    // down-levelled, which would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * No policy matches that id — it does not exist, or it belongs to another
 * tenant. Both are the same error and both answer 404, because RLS has already
 * made them indistinguishable and a 403 on the second would confirm the id names
 * a real row somewhere.
 */
export class SlaPolicyNotFoundError extends SlaError {
  constructor(readonly policyId: string) {
    super('No SLA policy matches that id.');
  }
}

/**
 * No alert matches that id **for this principal**.
 *
 * Three distinct facts collapse into one answer: no such alert, another tenant's
 * alert, and another supervisor's alert. The third is the one that matters —
 * 0006 is explicit that another principal's alert answers 404 and not 403, on
 * 0002's rule that a 403 confirms the id exists. A supervisor must not be able
 * to enumerate what a colleague was told about.
 */
export class SlaAlertNotFoundError extends SlaError {
  constructor(readonly alertId: string) {
    super('No SLA alert matches that id.');
  }
}

/** A cursor this build cannot act on. The controller turns it into `validation_failed`. */
export class InvalidSlaCursorError extends SlaError {
  constructor(readonly parameter: string) {
    super('The cursor is not valid. Start from the first page.');
  }
}

/**
 * The ticket a trigger names is not readable in the tenant scope the worker
 * opened.
 *
 * **Retryable**, and that is the whole reason it is an error rather than a skip:
 * the realistic cause is a job overtaking the transaction that wrote its ticket,
 * which the next attempt fixes. A forged or stale payload naming another
 * tenant's ticket reads zero rows under RLS and lands here too — it exhausts its
 * retry budget into the failed set, which is where a payload that never resolves
 * belongs.
 */
export class SlaTicketNotVisibleError extends SlaError {
  constructor(readonly ticketId: string) {
    super(`Ticket ${ticketId} is not visible in the tenant scope this job opened.`);
  }
}
