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

/**
 * Namespace for every BullMQ key. Explicit so a Redis instance shared with
 * anything else — a session store, a rate limiter — cannot collide with a queue
 * key, and so `KEYS whatsappcrm:*` is a complete answer during an incident.
 */
export const QUEUE_KEY_PREFIX = 'whatsappcrm';
