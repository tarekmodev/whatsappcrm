import 'server-only';

import {
  BillingSummaryResponseSchema,
  HostedSessionSchema,
  PlanListItemSchema,
  PlanListResponseSchema,
  UsageSummaryResponseSchema,
  type BillingSummaryResponse,
  type CheckoutRequest,
  type HostedSession,
  type PlanListItem,
  type PlanListResponse,
  type PortalRequest,
  type UsageSummaryResponse,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';
import { MalformedResponseError } from '@/lib/api/parse';

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

/**
 * `GET /v1/billing/plans` — every tier, plus this tenant's position in them.
 *
 * **The plans are validated one at a time, and a plan that fails is dropped**
 * rather than failing the response. The catalogue is platform-wide and the route
 * returns all of it, so parsing the array as a unit made one non-conforming row
 * — a plan key with a hyphen in it, left behind by a test fixture — the billing
 * page's error boundary for every tenant on the platform, with no way back from
 * the UI (TAR-657). A pricing page missing a tier is a bad page; a pricing page
 * that will not render is no page.
 *
 * It is a second line of defence, not the fix: `plans_key_format` and
 * `plans_entitlements_shape` stop the row being written in the first place. This
 * is what keeps the next unforeseen bad row from costing the whole surface.
 *
 * The envelope itself is **not** tolerated. `usage` drives the seat and volume
 * readings the page renders next to those plans, and a page that quietly invents
 * them is worse than one that fails.
 */
export async function getBillingPlans(): Promise<PlanListResponse> {
  const response = await authenticatedRequest({ method: 'GET', path: `${BILLING_PATH}/plans` });

  if (typeof response !== 'object' || response === null) {
    throw new MalformedResponseError('Expected a plan list envelope object.');
  }

  const { plans, usage } = response as { plans?: unknown; usage?: unknown };

  if (!Array.isArray(plans)) {
    throw new MalformedResponseError('Expected `plans` to be an array.');
  }

  // Re-parsed as a whole afterwards, so `usage` is still validated and the
  // returned value is the contract's type rather than a cast.
  return PlanListResponseSchema.parse({ plans: plans.filter(isRenderablePlan), usage });
}

/**
 * Whether one plan of the list matches the contract, logging it if it does not.
 *
 * Never swallowed: the server log keeps the plan the tenant must not be shown,
 * with enough of the row to identify it in the catalogue.
 */
function isRenderablePlan(plan: unknown): plan is PlanListItem {
  const result = PlanListItemSchema.safeParse(plan);

  if (!result.success) {
    const key = typeof plan === 'object' && plan !== null ? (plan as { key?: unknown }).key : plan;

    console.error(
      'Dropping a billing plan that does not match the contract',
      { key },
      result.error,
    );
  }

  return result.success;
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
