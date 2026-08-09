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
    conversationsThisPeriod: z.int().nonnegative(),
  }),
});

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
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;
export type PlanEntitlements = z.infer<typeof PlanEntitlementsSchema>;
export type Subscription = z.infer<typeof SubscriptionSchema>;
export type BillingSummaryResponse = z.infer<typeof BillingSummaryResponseSchema>;
export type BillingEventType = z.infer<typeof BillingEventTypeSchema>;
export type BillingEvent = z.infer<typeof BillingEventSchema>;

/** A hosted page the user is redirected to. Both checkout and portal return this. */
export interface HostedSession {
  url: string;
  expiresAt: string | null;
}

/**
 * The **only** surface through which the platform talks to a payment provider.
 *
 * Every method is deliberately expressed in our vocabulary (`planKey`, `seats`,
 * `tenantId`) rather than the provider's. `PolarBillingProvider` implements it
 * in TAR-37; `FakeBillingProvider` implements it for local development and
 * tests, which is what lets the whole billing flow be exercised without network
 * access or a sandbox account.
 */
export interface BillingProvider {
  /** Starts a subscription. Returns the hosted checkout page to redirect to. */
  createCheckout(input: {
    tenantId: string;
    planKey: string;
    seats: number;
    successUrl: string;
    cancelUrl: string;
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

  /** Translates a verified provider payload into our vocabulary, or `null` to ignore it. */
  parseWebhookEvent(payload: unknown): BillingEvent | null;
}

/** DI token for the port. Nest binds the concrete adapter to this in `BillingModule`. */
export const BILLING_PROVIDER = 'BILLING_PROVIDER';
