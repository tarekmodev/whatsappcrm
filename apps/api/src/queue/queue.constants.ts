/**
 * Queue and job names.
 *
 * String constants rather than an enum: they are wire values. A BullMQ job that
 * is already in Redis when a deploy lands still names itself with the old
 * string, so these are as much a compatibility surface as a route path — which
 * is why they are written once, here, and never inlined at a call site.
 *
 * Queue names are process-wide and shared by every tenant. Tenant scoping is
 * carried **in the job payload**, not in the queue name: a queue per tenant
 * would multiply Redis keys and blocking connections by the tenant count
 * (TAR-39, module map — `QueueModule` propagates tenant context into workers).
 */

/** Everything the webhook ingestion pipeline runs on. */
export const WEBHOOKS_QUEUE = 'webhooks';

/** Process one stored `webhook_events` row, named by id. */
export const PROCESS_WEBHOOK_EVENT_JOB = 'webhook.process-event';

/** The repeatable sweep that re-enqueues stored events nothing picked up. */
export const SWEEP_WEBHOOK_EVENTS_JOB = 'webhook.sweep-stuck-events';

/** Tenant-lifecycle background work that belongs to no single tenant. */
export const TENANCY_QUEUE = 'tenancy';

/**
 * The repeatable sweep that re-checks pending custom-domain claims and releases
 * lapsed ones (TAR-29).
 *
 * A queue job rather than a `@Cron`, for the reason `SWEEP_WEBHOOK_EVENTS_JOB`
 * gives: BullMQ's scheduler is what stops it running once per replica.
 */
export const SWEEP_TENANT_DOMAINS_JOB = 'tenancy.sweep-domain-verification';

/**
 * The repeatable lifecycle sweep (TAR-404, ADR 0009 decision 4): elapsed trials,
 * elapsed grace periods, due purges, the two timer reminders, and the
 * notification backstop.
 *
 * One job doing all six rather than six schedules, because every one of them is
 * a branch of the same two indexed scans over `tenants` and one over
 * `lifecycle_events` — and because a single last-success age is the signal
 * worth alerting on. 0009's failure table says the whole job fails safe by
 * construction: every way it can fail errs towards keeping access and keeping
 * data.
 */
export const SWEEP_TENANT_LIFECYCLE_JOB = 'tenancy.sweep-lifecycle';

/**
 * Send the tenant-admin email for one committed `lifecycle_events` row, named by
 * id.
 *
 * The **row id is the job id**, which is what makes a redelivery a no-op:
 * BullMQ answers `duplicate` for an id it already holds, and the handler
 * re-checks `notified_at` anyway (0009 decision 7).
 */
export const NOTIFY_TENANT_LIFECYCLE_JOB = 'tenancy.notify-lifecycle';

/**
 * Purge one tenant's data, named by tenant id.
 *
 * Its own job rather than work done inline by the sweep: a purge is batched and
 * can run for minutes on a large tenant, and a sweep that ran it inline would
 * hold the schedule's slot for that whole time and delay every other tenant's
 * timers behind it.
 */
export const PURGE_TENANT_JOB = 'tenancy.purge-tenant';

/**
 * Namespace for every BullMQ key. Explicit so a Redis instance shared with
 * anything else — a session store, a rate limiter — cannot collide with a queue
 * key, and so `KEYS whatsappcrm:*` is a complete answer during an incident.
 */
export const QUEUE_KEY_PREFIX = 'whatsappcrm';
