import type { PlanLimitName } from '../entitlements/entitlements.errors';

/**
 * The failures billing produces, as typed domain errors rather than
 * `HttpException`s — the same split `entitlements.errors.ts` and
 * `tenancy.errors.ts` make, and for the same reason: a service has no business
 * choosing a status code. `billing.http.ts` is the one table that maps them.
 *
 * None of them carries a provider name, a token, a customer record or an
 * amount. These messages reach a tenant admin's screen.
 */
export abstract class BillingError extends Error {
  protected constructor(message: string) {
    super(message);
    // `Error` breaks the prototype chain when a class extending it is
    // down-levelled, which would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * The payment provider could not be reached, refused, or is not configured for
 * this environment at all.
 *
 * One error for all three, deliberately. `upstream_unavailable` is what a caller
 * can act on — retry, or tell someone — and the difference between "Polar is
 * down", "this plan has no product id yet" and "no access token was ever
 * provisioned here" is an operator's question, answered in the log with the
 * cause. Telling an anonymous-ish caller which of the three it is describes our
 * deployment to them for nothing.
 */
export class BillingProviderUnavailableError extends BillingError {
  /**
   * Named `detail` rather than `cause`, which `Error` already owns: shadowing it
   * would make the standard property mean something narrower than every other
   * error in the process, and a log formatter walking `cause` would print a
   * sentence where it expected an error.
   */
  constructor(readonly detail: string) {
    super('Billing is temporarily unavailable. Please try again in a few minutes.');
  }
}

/** The requested `planKey` is not in the catalogue, or is no longer active. */
export class PlanNotFoundError extends BillingError {
  constructor(readonly planKey: string) {
    super('That plan is not available.');
  }
}

/**
 * A portal or plan change was asked for by a tenant that has never completed a
 * checkout, so there is no provider-side subscription to manage.
 *
 * `not_found` rather than `conflict`: the resource the caller asked for — their
 * billing portal — does not exist yet, and the console's answer is to show
 * checkout instead.
 */
export class NoSubscriptionError extends BillingError {
  constructor() {
    super('This workspace has no subscription to manage yet. Choose a plan to start one.');
  }
}

/**
 * Checkout was requested for a plan whose ceilings sit **below** what the tenant
 * is already using.
 *
 * Refused before checkout rather than after payment, which is the whole reason
 * `PlanListResponse.isSelectable` exists: a downgrade that leaves a tenant over
 * its own new cap would take the money and then refuse the next invite.
 */
export class PlanDowngradeBlockedError extends BillingError {
  constructor(
    readonly limit: PlanLimitName,
    readonly cap: number,
    readonly used: number,
  ) {
    super(
      `That plan includes ${cap} ${limit === 'seats' ? 'seat(s)' : 'conversation(s) per period'}, ` +
        `and this workspace is already using ${used}. Reduce usage first, or choose a larger plan.`,
    );
  }
}

/**
 * A billing webhook did not carry a valid signature, or carried a timestamp far
 * enough from now to be a replay of a captured delivery.
 *
 * The *reason* never leaves the log. To the caller both are one refusal, because
 * the difference between "wrong secret" and "stale timestamp" is a
 * reconnaissance signal for whoever is probing the endpoint.
 */
export class BillingWebhookRefusedError extends BillingError {
  constructor(readonly reason: string) {
    super('Signature verification failed.');
  }
}
