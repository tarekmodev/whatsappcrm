import { z } from 'zod';
import { IdSchema, MoneySchema, TimestampSchema } from './common';

/**
 * Billing — **provider-agnostic by construction**.
 *
 * TAR-18 names Polar.sh, and TAR-37 will integrate it. Nothing in this file
 * mentions Polar, and nothing outside `apps/api/src/billing/providers/` is
 * allowed to. Plans, entitlements and the tenant lifecycle are ours; the
 * provider is a payment rail we plug in behind the `BillingProvider` port below.
 *
 * The rule that makes this hold: **provider ids are opaque strings that only
 * the adapter interprets.** Plan logic keys off `planKey`, never off a price id.
 */

// ---------------------------------------------------------------------------
// Entitlements — what a plan grants
// ---------------------------------------------------------------------------

/**
 * Boolean capability gates, checked by `@RequireFeature('workflows')`.
 * Adding a feature here plus one row per plan is the whole cost of gating it.
 */
export const PLAN_FEATURES = [
  'assignment_rules',
  'sla_policies',
  'workflows',
  'ai_chatbot',
  'custom_branding',
  'custom_domain',
  'advanced_reporting',
  'api_access',
] as const;
export const PlanFeatureSchema = z.enum(PLAN_FEATURES);
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/**
 * Numeric ceilings. `null` means unlimited — deliberately not `-1` or
 * `Number.MAX_SAFE_INTEGER`, both of which invite arithmetic bugs at the
 * comparison site.
 */
export const PlanLimitsSchema = z.object({
  /** Billable agent seats. Enforced on invite acceptance, not on invite creation. */
  seats: z.int().positive().nullable(),
  /**
   * Conversations opened per billing period. At v1 this only warns and gates;
   * per-conversation overage billing is TAR-18's explicit non-goal, and the
   * counter in `usage.ts` is what makes switching it on a config change.
   */
  conversationsPerPeriod: z.int().positive().nullable(),
  whatsappNumbers: z.int().positive().nullable(),
  teams: z.int().positive().nullable(),
  knowledgeDocuments: z.int().positive().nullable(),
});

export const PlanEntitlementsSchema = z.object({
  features: z.array(PlanFeatureSchema),
  limits: PlanLimitsSchema,
});

export const PlanSchema = z.object({
  id: IdSchema,
  /** Stable business key. All plan logic branches on this, never on a provider id. */
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1).max(80),
  /** Price per seat per interval. */
  pricePerSeat: MoneySchema,
  interval: z.enum(['month', 'year']),
  entitlements: PlanEntitlementsSchema,
  /** Hidden from the pricing page but still honoured for tenants already on it. */
  isPublic: z.boolean(),
});

// ---------------------------------------------------------------------------
// Subscription — our record, hydrated from the provider
// ---------------------------------------------------------------------------

/**
 * Provider-neutral subscription states. Every provider's vocabulary is mapped
 * onto exactly these by the adapter, so lifecycle code never sees a Polar string.
 */
export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
] as const;
export const SubscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SubscriptionSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  planKey: z.string(),
  status: SubscriptionStatusSchema,
  /** Billed seat count. Reconciled against `seats_active` usage on every change. */
  seats: z.int().nonnegative(),
  /**
   * The provider's period, not the calendar month. Usage counters key off these
   * exact bounds so a counter can never straddle two invoices.
   */
  currentPeriodStart: TimestampSchema,
  currentPeriodEnd: TimestampSchema,
  cancelAtPeriodEnd: z.boolean(),
  trialEndsAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/** `GET /api/v1/billing/subscription` — what the billing settings page renders. */
export const BillingSummaryResponseSchema = z.object({
  subscription: SubscriptionSchema.nullable(),
  plan: PlanSchema.nullable(),
  entitlements: PlanEntitlementsSchema,
  /** Live counts against `limits`, so the UI can show "8 of 10 seats". */
  usage: z.object({
    seatsUsed: z.int().nonnegative(),
    /**
     * Unaccepted, unrevoked, unexpired invitations. A seat is held the moment it
     * is offered, not when it is taken — otherwise a tenant invites past its cap
     * and the refusal lands on the invitee. Counted separately from `seatsUsed`
     * so the console can say *why* the last seat is gone.
     */
    seatsPending: z.int().nonnegative(),
    conversationsThisPeriod: z.int().nonnegative(),
  }),
  /**
   * When a requested cancellation takes effect, or null. Present here so the
   * settings page renders its "closing on {date}" banner without a second call.
   *
   * Non-null does **not** mean the tenant is cancelled: they have paid through
   * this date and stay fully serviceable until it.
   */
  cancelsAt: TimestampSchema.nullable(),
});

/**
 * `GET /api/v1/billing/plans` — the plans view, with the tenant's position in it.
 *
 * The two derived booleans are computed server-side rather than left to the
 * console, because they depend on live usage the client does not hold and would
 * otherwise have to guess at.
 */
export const PlanListResponseSchema = z.object({
  plans: z.array(
    PlanSchema.extend({
      /** True for the plan the tenant is on now. */
      isCurrent: z.boolean(),
      /**
       * False when the plan's ceilings are below the tenant's current usage —
       * the console disables the button and says which limit blocks it. A
       * downgrade that would leave a tenant over its own new cap is refused
       * before checkout rather than after payment.
       */
      isSelectable: z.boolean(),
      /** Which ceilings block selection. Empty when `isSelectable`. */
      blockedBy: z.array(z.enum(['seats', 'conversationsPerPeriod'])),
    }),
  ),
  usage: z.object({
    seatsUsed: z.int().nonnegative(),
    seatsPending: z.int().nonnegative(),
    conversationsThisPeriod: z.int().nonnegative(),
  }),
});

/** `POST /api/v1/billing/checkout` request. Requires an `Idempotency-Key`. */
export const CheckoutRequestSchema = z.object({
  planKey: z.string().min(1).max(40),
  /**
   * Defaults to the tenant's current seat count (members + pending invites) and
   * is never below it — checking out fewer seats than are in use would create a
   * subscription that is over its own cap the moment it activates.
   */
  seats: z.int().positive().optional(),
  /**
   * Console-relative **paths, not URLs**. The API composes them against the
   * tenant's resolved origin. An absolute URL from the client is an open
   * redirect that a payment provider would faithfully honour, on the one page
   * where the user is most primed to trust where they land.
   */
  successPath: z.string().startsWith('/').max(512).optional(),
  cancelPath: z.string().startsWith('/').max(512).optional(),
});

/** `POST /api/v1/billing/portal` request. No idempotency key — see the contract. */
export const PortalRequestSchema = z.object({
  /** A path, not a URL, for the reason `CheckoutRequestSchema` states. */
  returnPath: z.string().startsWith('/').max(512).optional(),
});

/**
 * What happens when a tenant crosses its conversation volume allowance.
 *
 * `warn` is the default, and deliberately: blocking a helpdesk's replies is the
 * most damaging thing this system can do to a tenant's *customers*, and a
 * reseller will want a conversation before it happens. Inbound is never refused
 * under either policy — a customer's message is always accepted and stored.
 */
export const VOLUME_POLICIES = ['warn', 'block'] as const;
export const VolumePolicySchema = z.enum(VOLUME_POLICIES);
export type VolumePolicy = (typeof VOLUME_POLICIES)[number];

// ---------------------------------------------------------------------------
// The port — TAR-37 implements this once, for Polar
// ---------------------------------------------------------------------------

/**
 * Normalised billing events. The adapter translates each provider webhook into
 * one of these, or drops it. The tenant lifecycle state machine in `tenant.ts`
 * consumes only this union — that is the seam that keeps the provider out of
 * lifecycle logic.
 */
export const BILLING_EVENT_TYPES = [
  'subscription.activated',
  'subscription.updated',
  'subscription.past_due',
  'subscription.canceled',
  'payment.succeeded',
  'payment.failed',
] as const;
export const BillingEventTypeSchema = z.enum(BILLING_EVENT_TYPES);

export const BillingEventSchema = z.object({
  type: BillingEventTypeSchema,
  tenantId: IdSchema,
  /** Provider's event id, used to make webhook handling idempotent. */
  providerEventId: z.string().min(1),
  planKey: z.string().nullable(),
  seats: z.int().nonnegative().nullable(),
  status: SubscriptionStatusSchema.nullable(),
  currentPeriodStart: TimestampSchema.nullable(),
  currentPeriodEnd: TimestampSchema.nullable(),
  occurredAt: TimestampSchema,

  /**
   * Whether the subscription is set to end at the close of the current period.
   *
   * Optional rather than nullable-required, so an event that says nothing about
   * cancellation leaves the column alone — `undefined` is "no opinion" and
   * `false` is "the cancellation was withdrawn", and collapsing the two would
   * make every routine `subscription.updated` clear a pending cancellation.
   *
   * A requested cancellation is **not** a cancellation: the tenant has paid
   * through `cancelsAt` and stays fully serviceable until it, which is why this
   * pair writes no lifecycle transition.
   */
  cancelAtPeriodEnd: z.boolean().optional(),
  /** When a requested cancellation takes effect. `null` withdraws it. */
  cancelsAt: TimestampSchema.nullable().optional(),

  /**
   * The provider's own identifiers for this subscription and its customer.
   *
   * **Opaque strings the adapter alone interprets** — the same rule the
   * `subscriptions.provider_*` columns carry. They are here because the
   * consumer has to persist them: without the subscription id there is nothing
   * to call `updateSeats` or `getSubscription` against, and without the customer
   * id a portal session cannot be opened for a tenant whose checkout completed
   * before its first webhook landed.
   */
  providerSubscriptionId: z.string().min(1).optional(),
  providerCustomerId: z.string().min(1).optional(),

  /**
   * The provider's product identifier, when the event carries one.
   *
   * Present instead of a resolved `planKey` because the adapter cannot read the
   * catalogue: the product → plan mapping lives in `plans.provider_product_id`,
   * which is a database row, and a provider adapter that queried it would be an
   * adapter with an opinion about our pricing. The consumer resolves it, and
   * falls back to `planKey` for a provider that speaks in plan keys directly.
   */
  providerProductId: z.string().min(1).optional(),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;
export type PlanEntitlements = z.infer<typeof PlanEntitlementsSchema>;
export type Subscription = z.infer<typeof SubscriptionSchema>;
export type BillingSummaryResponse = z.infer<typeof BillingSummaryResponseSchema>;
export type PlanListResponse = z.infer<typeof PlanListResponseSchema>;
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;
export type PortalRequest = z.infer<typeof PortalRequestSchema>;
export type BillingEventType = z.infer<typeof BillingEventTypeSchema>;
export type BillingEvent = z.infer<typeof BillingEventSchema>;

/** A hosted page the user is redirected to. Both checkout and portal return this. */
export interface HostedSession {
  url: string;
  expiresAt: string | null;
}

/**
 * The wire schema for `HostedSession`, so the console can validate what
 * `POST /billing/checkout` and `POST /billing/portal` answer before it sends a
 * browser there.
 *
 * It exists because this is the one response in the contract the console does
 * not *render* — it **navigates to it**. A `url` that arrived malformed, or as
 * `javascript:` or `data:`, would be a redirect the user is maximally primed to
 * trust, on the one page where they are about to type card details. Parsing it
 * is the same control `CheckoutRequestSchema` applies in the other direction
 * when it refuses an absolute `successPath`.
 *
 * The **scheme is the control**, and it is the whole point of the schema: bare
 * `z.url()` accepts any scheme, so it would pass a `javascript:` or `data:`
 * target. The host is deliberately left alone — `z.httpUrl()` was the obvious
 * choice and is wrong here, because it also pins the hostname to a dotted
 * domain, which refuses a perfectly legitimate self-hosted or intranet
 * provider endpoint. Provider-agnostic by construction: this constrains the
 * *shape*, and says nothing about which host a session may live on, because
 * that is the adapter's business.
 *
 * Declared alongside the interface rather than replacing it: nothing that
 * already implements `BillingProvider` changes, and the annotation below ties
 * the two together, so they cannot drift without failing `typecheck`.
 */
export const HostedSessionSchema: z.ZodType<HostedSession> = z.object({
  url: z.url({ protocol: /^https?$/ }),
  expiresAt: TimestampSchema.nullable(),
});

/**
 * The **only** surface through which the platform talks to a payment provider.
 *
 * Every method is deliberately expressed in our vocabulary (`planKey`, `seats`,
 * `tenantId`) rather than the provider's. `PolarBillingProvider` implements it
 * in TAR-37; `FakeBillingProvider` implements it for local development and
 * tests, which is what lets the whole billing flow be exercised without network
 * access or a sandbox account.
 */
/**
 * Who a verified webhook payload is about, as far as the **provider** can say.
 *
 * Returned by `readWebhookSubject` so the receiver can resolve a tenant before
 * it parses. Every field is nullable because every one of them can be missing
 * from a legitimate delivery — an event for a subscription created before we
 * started stamping metadata carries no `tenantId`, and an event about a customer
 * carries no subscription id.
 *
 * The two provider ids are **opaque**: the receiver only ever compares them to
 * `subscriptions.provider_subscription_id` and `provider_customer_id`, which is
 * exactly what those columns exist for.
 */
export interface WebhookSubject {
  /** The tenant the provider is carrying for us, from metadata we set at checkout. */
  tenantId: string | null;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
}

export interface BillingProvider {
  /**
   * Starts a subscription. Returns the hosted checkout page to redirect to.
   *
   * `providerProductId` is read from `plans.provider_product_id` by the caller
   * and passed through untouched. The adapter cannot look it up itself — the
   * catalogue is ours, and a provider adapter that read `plans` would be one
   * with an opinion about our pricing. `null` means the plan has not been
   * mapped to a provider product yet, which every adapter that needs one must
   * refuse rather than call the provider with nothing.
   */
  createCheckout(input: {
    tenantId: string;
    planKey: string;
    seats: number;
    successUrl: string;
    cancelUrl: string;
    providerProductId: string | null;
  }): Promise<HostedSession>;

  /** Self-service management (payment method, invoices, cancellation). */
  createPortalSession(input: { tenantId: string; returnUrl: string }): Promise<HostedSession>;

  /** Re-reads the provider's truth. Used by the nightly reconciliation job. */
  getSubscription(input: { tenantId: string }): Promise<BillingEvent | null>;

  /** Per-seat metering: called whenever a seat is added or removed. */
  updateSeats(input: { tenantId: string; seats: number }): Promise<void>;

  /** `atPeriodEnd: false` cancels immediately; `true` schedules it. */
  cancelSubscription(input: { tenantId: string; atPeriodEnd: boolean }): Promise<void>;

  /**
   * Verifies the provider's webhook signature against the **raw** body.
   * Returns `false` rather than throwing, so the caller controls the response.
   *
   * Typed as `Uint8Array` rather than `Buffer`: this package is imported by the
   * browser bundle too, so it must not depend on Node's globals. A Node `Buffer`
   * satisfies it at the call site.
   */
  verifyWebhookSignature(rawBody: Uint8Array, headers: Record<string, string | undefined>): boolean;

  /**
   * Who a verified payload is about, before it is translated.
   *
   * Its own call rather than a field on the parsed event, because tenant
   * resolution has **three** branches and only the first is one an adapter can
   * answer: the metadata we stamped at checkout, then a lookup by provider
   * subscription id, then by provider customer id. The last two are reads of
   * `subscriptions`, which is the receiver's table and not the adapter's — so
   * the adapter reports what the payload names and the receiver decides who it
   * belongs to.
   */
  readWebhookSubject(payload: unknown): WebhookSubject;

  /**
   * Translates a verified provider payload into our vocabulary, or `null` to
   * ignore it.
   *
   * Takes the headers as well as the body because under Standard Webhooks — the
   * spec Polar signs with — **the event id is a header** (`webhook-id`), not a
   * body field, and `BillingEvent.providerEventId` is what makes webhook
   * handling idempotent. A parser given only the body cannot populate the one
   * field the replay defence turns on.
   *
   * Takes the resolved `tenantId` for the mirror-image reason: `BillingEvent`
   * carries one and two of the three ways to establish it are database lookups
   * the adapter may not make. The receiver resolves it through
   * `readWebhookSubject` first and passes it in.
   */
  parseWebhookEvent(
    payload: unknown,
    headers: Record<string, string | undefined>,
    tenantId: string,
  ): BillingEvent | null;

  /**
   * Resolves a completed checkout into the plan and seats the tenant actually
   * bought. Called on return from the hosted page so the console reflects the
   * new plan immediately rather than waiting on a webhook that may be seconds
   * behind — the redirect lands before the delivery does.
   *
   * Returns `null` while the session is still open. Not a substitute for the
   * webhook: this is the fast path, the webhook is the authoritative one, and
   * both are made safe to apply by `subscriptions.last_event_at`.
   */
  resolveCheckout(input: { tenantId: string; checkoutId: string }): Promise<BillingEvent | null>;

  /**
   * Moves the tenant to a different plan on the **existing** subscription.
   * Distinct from `createCheckout`, which only opens one — an upgrade from a
   * paid tier is a subscription amendment, not a second purchase.
   */
  changePlan(input: {
    tenantId: string;
    planKey: string;
    seats: number;
    providerProductId: string | null;
  }): Promise<void>;
}

/** DI token for the port. Nest binds the concrete adapter to this in `BillingModule`. */
export const BILLING_PROVIDER = 'BILLING_PROVIDER';
