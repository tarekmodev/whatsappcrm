import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

/**
 * Usage counters — seats and conversation volume, per tenant, per billing period.
 *
 * TAR-18 bills per seat at v1 and lists per-conversation overage as a non-goal,
 * "so usage data is captured such that it can be switched on later without a
 * migration". That sentence is this file's entire reason to exist: the counters
 * are recorded from day one even though only `seats_active` is billed today.
 */

export const USAGE_METRICS = [
  /**
   * Gauge, not a counter: the number of billable seats *right now*. Recomputed
   * on every membership change and pushed to the provider via `updateSeats`.
   * Stored as the period's high-water mark, because that is what per-seat
   * billing charges for.
   */
  'seats_active',
  /** Conversations opened in the period. The per-tier allowance meters on this. */
  'conversations_opened',
  'messages_sent',
  'messages_received',
  /** LLM replies produced by TAR-28. Not billed at v1; captured because it is a real cost. */
  'ai_replies',
] as const;

export const UsageMetricSchema = z.enum(USAGE_METRICS);
export type UsageMetric = (typeof USAGE_METRICS)[number];

export const USAGE_METRIC_KINDS: Record<UsageMetric, 'counter' | 'gauge'> = {
  seats_active: 'gauge',
  conversations_opened: 'counter',
  messages_sent: 'counter',
  messages_received: 'counter',
  ai_replies: 'counter',
};

/**
 * A period is always the subscription's own billing period, never a calendar
 * month. Deriving it from the subscription is what stops a counter straddling
 * two invoices when a tenant upgrades mid-month.
 *
 * Tenants with no subscription (trialing before checkout) fall back to a
 * calendar month anchored on `tenant.createdAt`.
 */
export const UsagePeriodSchema = z.object({
  start: TimestampSchema,
  end: TimestampSchema,
});

export const UsageCounterSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  metric: UsageMetricSchema,
  period: UsagePeriodSchema,
  value: z.int().nonnegative(),
  updatedAt: TimestampSchema,
});

/** `GET /api/v1/billing/usage` — the usage panel, and the source for allowance warnings. */
export const UsageSummaryResponseSchema = z.object({
  period: UsagePeriodSchema,
  counters: z.array(
    z.object({
      metric: UsageMetricSchema,
      value: z.int().nonnegative(),
      /** The plan ceiling, or `null` when unlimited or unmetered. */
      limit: z.int().positive().nullable(),
    }),
  ),
});

export type UsagePeriod = z.infer<typeof UsagePeriodSchema>;
export type UsageCounter = z.infer<typeof UsageCounterSchema>;
export type UsageSummaryResponse = z.infer<typeof UsageSummaryResponseSchema>;

/**
 * The counter interface every feature writes through.
 *
 * **Correctness rule, and the reason this is not a naive `INCR`:** an increment
 * must happen in the *same database transaction* as the row that causes it — the
 * conversation insert, the message insert. Webhook deliveries are replayed by
 * Meta, and a replay that hits the `provider_message_id` unique constraint rolls
 * back the transaction and therefore the increment too. Incrementing in Redis at
 * the edge would double-count on every retry, silently, in the one subsystem
 * where wrong numbers become wrong invoices.
 *
 * `reconcile()` is the backstop: a nightly job recomputes each counter from the
 * source tables and corrects drift, so a bug costs one day of accuracy rather
 * than a permanently wrong invoice.
 */
export interface UsageService {
  /**
   * Adds `by` to a counter metric for the tenant's current period.
   * Must be called inside the caller's transaction.
   */
  increment(input: {
    tenantId: string;
    metric: UsageMetric;
    by?: number;
    /** Defaults to now; pass the source row's timestamp for backfills. */
    at?: Date;
  }): Promise<void>;

  /** Sets a gauge metric, keeping the period's high-water mark. */
  recordGauge(input: { tenantId: string; metric: UsageMetric; value: number }): Promise<void>;

  /** Current value, used by quota checks on the request path. */
  current(input: { tenantId: string; metric: UsageMetric }): Promise<number>;

  summary(input: { tenantId: string }): Promise<UsageSummaryResponse>;

  /** Recomputes counters from source tables for one period. Idempotent. */
  reconcile(input: { tenantId: string; period: UsagePeriod }): Promise<void>;
}

export const USAGE_SERVICE = 'USAGE_SERVICE';
