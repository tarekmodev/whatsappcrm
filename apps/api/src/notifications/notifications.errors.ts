/**
 * The failures the notifications surface produces, as typed domain errors rather
 * than `HttpException`s.
 *
 * The same split `sla.errors.ts` makes, for the same reason: a service has no
 * business choosing a status code, and `notifications.http.ts` is the one place
 * that decides. Anything not listed here reaches the caller as a 500, which is
 * the correct answer for a fault.
 */

export abstract class NotificationError extends Error {
  protected constructor(message: string) {
    super(message);
    // `Error` breaks the prototype chain when a class extending it is
    // down-levelled, which would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * No notification matches that id **for this principal**.
 *
 * Three distinct facts collapse into one answer: no such notification, another
 * tenant's, and another recipient's. The third is the one that matters — 0002's
 * rule is that a 403 confirms the id exists, and this is a resource whose whole
 * point is that it was addressed to one person, so a recipient must not be able
 * to enumerate what a colleague was told about.
 *
 * An `escalation` row is the fourth fact behind the same answer: it is excluded
 * from this surface by `PUBLISHED_NOTIFICATION_TYPES_ONLY` and is acknowledged
 * through `POST /api/v1/escalation-alerts/{id}/acknowledge` instead.
 */
export class NotificationNotFoundError extends NotificationError {
  constructor(readonly notificationId: string) {
    super('No notification matches that id.');
  }
}

/** A cursor this build cannot act on. The controller turns it into `validation_failed`. */
export class InvalidNotificationCursorError extends NotificationError {
  constructor(readonly parameter: string) {
    super('The cursor is not valid. Start from the first page.');
  }
}
