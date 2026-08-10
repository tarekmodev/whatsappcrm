import type { TenantJobData } from '../queue/queue.service';

/**
 * Payloads for the jobs this module runs, and the stable ids that deduplicate
 * them.
 *
 * Both jobs are keyed on a **durable row id** rather than on the payload they
 * describe (TAR-39, failure modes: "jobs must be idempotent; every one is keyed
 * on a durable row id"). A worker that crashed mid-job, a Meta retry and a
 * sweeper re-enqueue therefore all name the same row, and the claim in
 * `WebhookEventsRepository` decides which of them does the work.
 *
 * `tenantId` is `null` on both, and that is not an oversight: an inbound webhook
 * is stored before its tenant is known — routing it is the worker's first job —
 * so there is nothing honest to put there. The worker opens a tenant scope of
 * its own once `phone_number_id` resolves.
 */

export interface ProcessWebhookEventJob extends TenantJobData {
  readonly webhookEventId: string;
}

/** The sweep carries no payload; the threshold comes from configuration. */
export type SweepWebhookEventsJob = TenantJobData;

/**
 * Collapses a Meta retry and a sweeper re-enqueue of the same row into one
 * queued job.
 *
 * An optimisation, not the correctness mechanism: BullMQ forgets a job id once
 * it leaves the completed set, so the same row can legitimately be queued again
 * later. What actually prevents double processing is the status-scoped claim.
 *
 * Hyphen-separated, not colon-separated: BullMQ reserves `:` for its own Redis
 * key structure and rejects a custom job id containing one — at `add()` time, in
 * the one code path that is allowed to fail without failing the request, which
 * is exactly where a silent regression would hide.
 */
export function processWebhookEventJobId(webhookEventId: string): string {
  return `webhook-event-${webhookEventId}`;
}

/**
 * The id a **sweep** re-enqueues under, which is deliberately not the one above.
 *
 * `removeOnFail` retains a failed job under its id for a long time, and BullMQ
 * ignores an `add` for an id it still holds — in the failed set as much as in
 * the waiting one. So a row whose terminal database write failed after the job
 * exhausted its retries leaves a corpse holding exactly the id the sweeper would
 * re-add under, and every sweep from then on is a silent no-op. The sweeper
 * exists for precisely that row.
 *
 * Suffixed with the sweep's own timestamp rather than made unique per call: two
 * events found in one sweep still get distinct ids, and a single event found
 * twice in one sweep — impossible today, cheap to be right about — collapses
 * into one job. The claim in `WebhookEventsRepository` remains what prevents
 * double processing; this only decides whether the job is created at all.
 */
export function sweptWebhookEventJobId(webhookEventId: string, sweptAt: Date): string {
  return `${processWebhookEventJobId(webhookEventId)}-sweep-${sweptAt.getTime()}`;
}
