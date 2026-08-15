/**
 * The failures plan-limit enforcement produces, as typed domain errors rather
 * than `HttpException`s — the same split `people.errors.ts` and
 * `conversations.errors.ts` make, and for the same reason: a service has no
 * business choosing a status code.
 *
 * There is only one of them, and that is deliberate. Every limit in
 * `PlanLimitsSchema` refuses with the same published code
 * (`plan_limit_exceeded`, 0002's taxonomy), so the *limit* travels as a field
 * on the error rather than as a code per quota. A code per quota would make
 * `error-codes.ts` something an implementation edits rather than something 0002
 * rules, and every new plan limit would become a contract change.
 */

/**
 * Which ceiling refused the write — the two `tenant_plan_limits` stores, named
 * as `PlanLimitsSchema` names them so the field a client reads matches the
 * published vocabulary.
 *
 * `conversationsPerPeriod` has no factory below yet: its enforcement point is
 * the outbound send, and the `conversations_opened` usage counter it would be
 * compared against has no writer on `main`. See `plan-limits.service.ts`.
 */
export type PlanLimitName = 'seats' | 'conversationsPerPeriod';

/**
 * A write refused because the tenant's plan has no room left for it.
 *
 * `cap` and `used` are carried so the caller can render "3 of 3 seats in use"
 * without a second request, and so a support engineer reading the log line
 * knows whether the tenant is at the cap or past it — the second is a bug in
 * enforcement and the first is enforcement working.
 *
 * The message names a support contact rather than a checkout page on purpose:
 * TAR-37 is in `backlog`, so there is no plan to upgrade to yet (0009, risk 4).
 * When it lands, this string is the one place that changes.
 */
export class PlanLimitExceededError extends Error {
  constructor(
    readonly limit: PlanLimitName,
    readonly cap: number,
    readonly used: number,
    message: string,
  ) {
    super(message);
    // `Error` breaks the prototype chain when a class extending it is
    // down-levelled, which would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }

  static seats(cap: number, used: number): PlanLimitExceededError {
    return new PlanLimitExceededError(
      'seats',
      cap,
      used,
      `This workspace's plan includes ${cap} seat(s) and all of them are taken. ` +
        'Remove a member or withdraw a pending invitation, or contact support to raise the limit.',
    );
  }
}
