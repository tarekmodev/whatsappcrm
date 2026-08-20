import type { JobsOptions } from 'bullmq';

/**
 * The job ids and retry options the lifecycle queue uses, in one file.
 *
 * `webhook-jobs.ts` is the precedent and the reason this exists as a module
 * rather than as template literals at the call sites: a stable BullMQ job id is
 * a **correctness mechanism**, not a label, and getting one wrong fails silently
 * in both directions. Two ways, both of which this file exists to stop:
 *
 *   1. **A colon.** BullMQ refuses a custom id containing `:` unless it splits
 *      into exactly three parts — `Job.validateOptions` throws `Custom Id cannot
 *      contain :`. `QueueService.enqueue` catches every throw and reports
 *      `failed`, so a bad id is not a crash: it is a job that is never created,
 *      logged once per attempt, with the caller counting zero. That is precisely
 *      how `purge:<tenantId>` stopped every hard delete in this feature from
 *      running at all.
 *   2. **A corpse holding the id.** BullMQ ignores an `add` for an id it still
 *      holds — in the *failed* set as much as the waiting one — so a stable id
 *      plus retained failures is a job that can never be re-queued. That is the
 *      trap `sweptWebhookEventJobId` was written for, and the notification
 *      backstop below has exactly the same shape.
 *
 * Hyphens, never colons. The ids read as one token because that is what they are.
 */

/**
 * How a lifecycle notification is retried before it is given up on.
 *
 * Three attempts with exponential backoff: the failures worth retrying here are
 * a mailer blip or a database hiccup, both of which clear in seconds. Past that
 * the row still carries `notified_at IS NULL`, so the sweep's backstop is what
 * tries again — under a *different* id, see below.
 *
 * `removeOnFail` retains a bounded number of failed jobs for inspection, which
 * is the whole reason the backstop cannot reuse this id.
 */
export const LIFECYCLE_NOTIFICATION_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
};

/**
 * The id the transition path enqueues a notification under.
 *
 * Deterministic on the `lifecycle_events` row id, which is what makes a
 * redelivery of the same transition a duplicate BullMQ discards rather than a
 * second email to every admin in the tenant. `notified_at` is the actual
 * idempotency mechanism; this only decides whether a second job is created.
 */
export function lifecycleNotificationJobId(eventId: string): string {
  return `lifecycle-event-${eventId}`;
}

/**
 * The id the **sweep** re-enqueues a notification under, deliberately not the
 * one above.
 *
 * A notification whose three attempts were exhausted leaves a failed job holding
 * `lifecycleNotificationJobId(eventId)` for as long as `removeOnFail` retains
 * it. The row it describes still has `notified_at IS NULL` — that is exactly the
 * row the backstop exists for — and re-adding under the same id would be
 * ignored, silently, on every sweep from then on. One transient failure would
 * permanently swallow the notice that a tenant had been suspended.
 *
 * Suffixed with the sweep's own instant rather than made unique per call, so two
 * rows found in one sweep still get distinct ids and one row found twice in the
 * same sweep collapses into one job.
 */
export function sweptLifecycleNotificationJobId(eventId: string, sweptAt: Date): string {
  return `${lifecycleNotificationJobId(eventId)}-sweep-${sweptAt.getTime()}`;
}

/**
 * How a purge job is retried, which is **not at all**.
 *
 * A purge is resumable by design — `purge_started_at` is stamped before the
 * first batch and the next sweep picks a half-finished one back up — so BullMQ
 * retrying inside the same job would race the sweep's own recovery and hold the
 * worker's slot while it did. One attempt, and the clock is the retry.
 *
 * `removeOnFail: true` rather than the retention the notification uses, and it
 * is the half that makes resumability real: a failed purge that stayed in the
 * failed set would hold `purgeTenantJobId(tenantId)` and every later sweep's
 * re-queue would be ignored, so the tenant would sit `suspended` with
 * `purge_started_at` set for ever — the stuck-purge alert condition, caused by
 * the very mechanism meant to recover from it. Removing the failure frees the id
 * for the next sweep.
 *
 * `removeOnComplete: true` for symmetry and for nothing else: a completed purge
 * moved the tenant to `deleted`, and the sweep's `status = 'suspended'`
 * predicate cannot select it again.
 */
export const PURGE_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: true,
};

/**
 * The id a purge is queued under, and the concurrency control for it.
 *
 * Stable on the tenant, so while a purge is waiting or running its id is held
 * and the next five-minute sweep cannot queue a second one against the same
 * tenant. Two concurrent purges would interleave their batched deletes and race
 * to write the terminal `→ deleted` transition.
 *
 * ⚠️ Hyphens. `purge:<tenantId>` — the shape this replaces — is refused by
 * BullMQ outright, and refused quietly enough that every hard delete in the
 * product silently stopped happening.
 */
export function purgeTenantJobId(tenantId: string): string {
  return `purge-tenant-${tenantId}`;
}
