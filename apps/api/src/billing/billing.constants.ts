import type { WebhookProvider } from '@whatsappcrm/contracts';

/**
 * The `webhook_events.provider` value every billing delivery is stored under.
 *
 * **`'billing'`, not `'polar'`**, and that is a deliberate correction to the
 * contract's prose. The published `WEBHOOK_PROVIDERS` enum carries `'billing'`,
 * and the port's whole premise is that no provider name appears outside
 * `providers/polar/` — a `'polar'` literal written by the ingest service would
 * be exactly the leak the seam exists to prevent, and it would need migrating
 * the day a second provider is added. The replay defence is unaffected: the
 * unique key is `(provider, provider_event_id)`, and the event id is the
 * provider's own.
 */
export const BILLING_WEBHOOK_PROVIDER: WebhookProvider = 'billing';

/**
 * Collapses a provider retry and a sweeper re-enqueue of the same row into one
 * queued job.
 *
 * An optimisation, not the correctness mechanism: BullMQ forgets a job id once
 * it leaves the completed set, so the same row can legitimately be queued again
 * later. What actually prevents double processing is the status-scoped claim in
 * `WebhookEventsRepository`.
 *
 * Hyphen-separated, not colon-separated: BullMQ reserves `:` for its own Redis
 * key structure and rejects a custom job id containing one.
 */
export function processBillingEventJobId(webhookEventId: string): string {
  return `billing-event-${webhookEventId}`;
}

/**
 * The id a **sweep** re-enqueues under, which is deliberately not the one above.
 *
 * `removeOnFail` retains a failed job under its id for a long time, and BullMQ
 * ignores an `add` for an id it still holds — in the failed set as much as in
 * the waiting one. A row whose terminal write failed after the job exhausted its
 * retries would otherwise leave a corpse holding exactly the id the sweeper
 * re-adds under, and every sweep from then on would be a silent no-op. The
 * sweeper exists for precisely that row.
 */
export function sweptBillingEventJobId(webhookEventId: string, sweptAt: Date): string {
  return `${processBillingEventJobId(webhookEventId)}-sweep-${sweptAt.getTime()}`;
}

/** Deterministic on the tenant, so two membership changes a second apart queue one push. */
export function syncBillingSeatsJobId(tenantId: string): string {
  return `billing-seats-${tenantId}`;
}
