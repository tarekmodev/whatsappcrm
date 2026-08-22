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
 * Which ceiling refused the write — the limits in `tenant_entitlements`, named
 * as `PlanLimitsSchema` names them so the field a client reads matches the
 * published vocabulary.
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
 * The message names the **upgrade path** rather than a support contact, and
 * that is the one line TAR-37 changed here. Until billing landed there was no
 * plan to upgrade to (0009, risk 4), so "contact support" was the only honest
 * answer; now `GET /api/v1/billing/plans` exists and the refusal can tell an
 * admin what to do about it.
 *
 * It names the destination in words rather than as a URL. The console renders
 * the link — from this error's `code` and `details`, which is what
 * `PlanListResponse` and the seat panel are for — and a message carrying a path
 * would put a routing decision inside a domain error, where a console redesign
 * would silently make it wrong.
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
        'Remove a member, withdraw a pending invitation, or upgrade to a plan with more seats ' +
        'from billing settings.',
    );
  }

  /**
   * The period's conversation allowance is spent.
   *
   * The message says what is still working, because the difference matters to
   * the person reading it and is the whole design of this cap: inbound is never
   * refused. A customer's message is accepted and stored whatever the counter
   * says; what the cap withholds is the tenant's ability to reply.
   */
  static conversationsPerPeriod(cap: number, used: number): PlanLimitExceededError {
    return new PlanLimitExceededError(
      'conversationsPerPeriod',
      cap,
      used,
      `This workspace's plan includes ${cap} conversation(s) per period, and that has been ` +
        'reached. Incoming messages are still being received and stored; upgrade to a plan with ' +
        'a larger allowance from billing settings to reply.',
    );
  }
}
