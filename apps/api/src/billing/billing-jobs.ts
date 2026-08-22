import type { TenantJobData } from '../queue/queue.service';

/**
 * Payloads for the jobs `BillingModule` runs.
 *
 * Every one is keyed on a **durable row id** rather than on the payload it
 * describes, the rule the webhook pipeline already follows: a worker that
 * crashed mid-job, a provider retry and a sweeper re-enqueue all name the same
 * row, and the claim in `WebhookEventsRepository` decides which of them does the
 * work.
 */

/**
 * `tenantId` is `null` and that is not an oversight: a billing webhook is stored
 * before its tenant is known — resolving it is the worker's first job — so there
 * is nothing honest to put there.
 */
export interface ProcessBillingEventJob extends TenantJobData {
  readonly webhookEventId: string;
}

/**
 * Push this tenant's seat count to the provider.
 *
 * `allowDecrease` is the policy switch, and it is on the job rather than read
 * from configuration because it depends on *why* the count changed. A tenant
 * that removes a member mid-period keeps the paid seat until the period ends —
 * reducing immediately would issue a credit for a seat that may be re-filled
 * next week — so a membership change pushes increases only. A period roll
 * applies the reduction that has been waiting for it.
 */
export interface SyncBillingSeatsJob extends TenantJobData {
  readonly tenantId: string;
  readonly allowDecrease: boolean;
}

/** Neither the sweep nor the reconciliation carries a payload. */
export type BillingMaintenanceJob = TenantJobData;
