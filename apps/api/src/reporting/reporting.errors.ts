/**
 * The failures the reporting surface produces, as typed domain errors rather
 * than `HttpException`s.
 *
 * The same split `sla.errors.ts` and `conversations.errors.ts` make, for the
 * same reason: a service has no business choosing a status code, and
 * `reporting.http.ts` is the one place that decides. Anything not listed here
 * reaches the caller as a 500, which is the correct answer for a fault — and,
 * per ADR 0010's error table, for a report that exceeds its statement timeout.
 */

export abstract class ReportingError extends Error {
  protected constructor(message: string) {
    super(message);
    // `Error` breaks the prototype chain when a class extending it is
    // down-levelled, which would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * `assignedTeamId` names no team this tenant has.
 *
 * Two facts collapse into one answer: no such team, and another tenant's team.
 * RLS has already made them indistinguishable to the lookup, and 0002's rule is
 * that a 403 confirms an id exists — so this is `not_found`, never `forbidden`.
 */
export class ReportTeamNotFoundError extends ReportingError {
  constructor(readonly teamId: string) {
    super('No team matches that id.');
  }
}
