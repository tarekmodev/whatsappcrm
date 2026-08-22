import { ApiException } from '../common/errors/api.exception';
import { isTenantNotActiveError, tenantInactive } from '../common/errors/tenant-inactive';
import {
  IdempotencyKeyReusedError,
  IdempotentRequestInFlightError,
} from '../common/idempotency/idempotency.errors';
import { PlanLimitExceededError } from '../entitlements/entitlements.errors';
import {
  BillingProviderUnavailableError,
  NoSubscriptionError,
  PlanDowngradeBlockedError,
  PlanNotFoundError,
} from './billing.errors';

/**
 * The billing failures as the published error taxonomy states them
 * (`packages/contracts/src/error-codes.ts`).
 *
 * One table rather than a `catch` per handler, so the same condition cannot
 * answer 402 on one route and 409 on another. **No new error codes** — the
 * existing taxonomy covers every case here, which is a sign it was drawn
 * correctly rather than an accident.
 *
 * The mappings worth arguing about:
 *
 *   * **a blocked downgrade is `plan_limit_exceeded`, 402**, and not
 *     `validation_failed`. The request is well formed and the caller is
 *     permitted; the plan they picked simply does not fit the workspace they
 *     have. It carries the same `details` shape as a refused invite, so the
 *     console renders "10 of 3 seats in use" from one branch rather than two.
 *   * **an unreachable provider is `upstream_unavailable`, 502**, including the
 *     case where the plan has no provider product id yet. Both mean "we could
 *     not open a checkout, try later", and neither is the caller's fault.
 *   * **no subscription is `not_found`, 404.** The portal is a resource that
 *     does not exist until a checkout completes, and the console's answer is to
 *     offer checkout rather than to report an error.
 *
 * Anything not listed is not ours to interpret and is re-thrown, so it reaches
 * the global filter as the 500 a fault should be.
 */
export function translateBillingFailure(error: unknown): never {
  if (error instanceof BillingProviderUnavailableError) {
    throw new ApiException('upstream_unavailable', error.message);
  }

  if (error instanceof PlanNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof NoSubscriptionError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof PlanDowngradeBlockedError) {
    throw new ApiException('plan_limit_exceeded', error.message, [
      { path: error.limit, message: `${error.used} of ${error.cap} in use` },
    ]);
  }

  if (error instanceof PlanLimitExceededError) {
    // Reachable when the provider call itself trips a ceiling. Same envelope as
    // the invite path's refusal, on purpose: the console has one renderer for
    // "your plan is full", whichever route produced it.
    throw new ApiException('plan_limit_exceeded', error.message, [
      { path: error.limit, message: `${error.used} of ${error.cap} in use` },
    ]);
  }

  if (error instanceof IdempotencyKeyReusedError) {
    throw new ApiException('idempotency_key_reused', error.message);
  }

  if (error instanceof IdempotentRequestInFlightError) {
    throw new ApiException('conflict', error.message);
  }

  if (isTenantNotActiveError(error)) {
    // The database gate refused. Reachable for a `created` or `deleted` tenant
    // only — `suspended` and `cancelled` are admitted, which is the point of the
    // recovery allowlist these routes carry.
    throw tenantInactive();
  }

  throw error;
}
