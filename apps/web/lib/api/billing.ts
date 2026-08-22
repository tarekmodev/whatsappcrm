import 'server-only';

import {
  BillingSummaryResponseSchema,
  HostedSessionSchema,
  PlanListResponseSchema,
  UsageSummaryResponseSchema,
  type BillingSummaryResponse,
  type CheckoutRequest,
  type HostedSession,
  type PlanListResponse,
  type PortalRequest,
  type UsageSummaryResponse,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';

/**
 * The five billing routes, exactly as the TAR-37 contract publishes them. No
 * component calls `fetch`; it calls one of these, so each response is validated
 * against the contract in one place.
 *
 * ## Nothing here names the payment provider
 *
 * That is the point of the port. The console asks for a plan list, a checkout
 * session and a portal session; which rail answers is decided in
 * `apps/api/src/billing/providers/`, and every provider identifier that reaches
 * this tier is an opaque string inside a URL we redirect to. A second provider —
 * or the sandbox/production switch — is invisible from here, which is what lets
 * this surface be built and reviewed before any of it exists.
 *
 * ## Why the two `POST`s are not symmetrical
 *
 * `POST /billing/checkout` carries an `Idempotency-Key` and `POST /billing/portal`
 * does not, and that asymmetry is the contract's: a checkout is a `POST` with an
 * external side effect — it can start a subscription — while a portal session is
 * short-lived, free to mint and safe to repeat. Requiring a key on the "manage
 * billing" button would be friction for nothing.
 *
 * ## Why nothing here is cached
 *
 * Every one of these answers depends on live usage and on a subscription the
 * provider's webhook can change between two requests. `apiRequest` already sends
 * `cache: 'no-store'`; the pages that call these are `force-dynamic` for the same
 * reason. A cached plan list is a tenant told it can still invite somebody it
 * cannot.
 */

const BILLING_PATH = '/v1/billing';

/** `GET /v1/billing/plans` — every tier, plus this tenant's position in them. */
export async function getBillingPlans(): Promise<PlanListResponse> {
  return PlanListResponseSchema.parse(
    await authenticatedRequest({ method: 'GET', path: `${BILLING_PATH}/plans` }),
  );
}

/** `GET /v1/billing/subscription` — the current plan, its dates and its usage. */
export async function getBillingSummary(): Promise<BillingSummaryResponse> {
  return BillingSummaryResponseSchema.parse(
    await authenticatedRequest({ method: 'GET', path: `${BILLING_PATH}/subscription` }),
  );
}

/** `GET /v1/billing/usage` — counters against their ceilings for this period. */
export async function getBillingUsage(): Promise<UsageSummaryResponse> {
  return UsageSummaryResponseSchema.parse(
    await authenticatedRequest({ method: 'GET', path: `${BILLING_PATH}/usage` }),
  );
}

/**
 * `POST /v1/billing/checkout` — opens a hosted checkout page.
 *
 * The key is minted by the caller rather than here, because it has to identify
 * *one intent*: a retry of the same click must carry the same key, and two
 * deliberate clicks must not. Generating it inside this function would make
 * every call a new intent and defeat the header entirely.
 *
 * `successPath` and `cancelPath` are console-relative **paths**. The API composes
 * them against the tenant's own resolved origin, so a caller cannot aim the
 * post-payment redirect at another host — which is the one redirect a user is
 * most primed to follow without looking.
 */
export async function createCheckoutSession(
  input: CheckoutRequest,
  idempotencyKey: string,
): Promise<HostedSession> {
  return HostedSessionSchema.parse(
    await authenticatedRequest({
      method: 'POST',
      path: `${BILLING_PATH}/checkout`,
      body: input,
      headers: { 'idempotency-key': idempotencyKey },
    }),
  );
}

/**
 * `POST /v1/billing/portal` — mints a short-lived link into the provider's own
 * customer portal, where invoices, the payment method, plan changes and
 * cancellation all live.
 *
 * Minted on click and never stored: these sessions expire in minutes, and a
 * cached one is a dead link on a page whose whole purpose is to be pressed.
 */
export async function createPortalSession(input: PortalRequest): Promise<HostedSession> {
  return HostedSessionSchema.parse(
    await authenticatedRequest({ method: 'POST', path: `${BILLING_PATH}/portal`, body: input }),
  );
}
