import type { SlaTargetKind } from '@whatsappcrm/contracts';

/**
 * Everything the SLA mechanism needs that is not a wire value.
 *
 * The queue name, the two job names and the job id belong to
 * `@whatsappcrm/contracts/sla` because they are shared with the modules that
 * enqueue; what is here is local to the worker and the sweep.
 */

/**
 * Stable id for the repeatable sweep, so a rolling deploy replaces the schedule
 * rather than accumulating one per replica. `QueueService.schedule` wraps
 * `upsertJobScheduler`, which is idempotent on this key.
 */
export const SLA_SWEEP_SCHEDULE_KEY = 'sla-sweep';

/**
 * The two targets a policy can define, in the order timers are created and
 * reconciled. Ordered rather than a `Set` so a log line and a test read the same
 * sequence every run.
 */
export const SLA_TIMER_KINDS: readonly SlaTargetKind[] = ['first_response', 'resolution'];

/**
 * How many due timers one sweep claims.
 *
 * Bounded for the reason `WebhookSweeperService` bounds its own batch: after an
 * outage the backlog can be arbitrarily large, and a sweep that claimed all of
 * it would hold one long transaction per tenant and then emit a burst of
 * sockets. Oldest deadline first, capped, every interval — the backlog drains in
 * breach order across several sweeps.
 *
 * 0006 names the signal that this has stopped being enough: **a full batch
 * returned on consecutive sweeps**. `SlaSweepService` logs the batch size on
 * every run that finds work so that signal exists without extra instrumentation.
 */
export const SLA_SWEEP_BATCH = 200;

/**
 * How long one tenant's phase-2 transaction may take.
 *
 * Prisma's default interactive-transaction timeout is 5 seconds, which is fine
 * for the common case of a handful of timers. This raises it for the recovery
 * case — a tenant with a full batch of breached timers, each resolving
 * recipients — while staying far short of the sweep interval, so a stuck tenant
 * fails rather than overlapping the next tick indefinitely.
 */
export const SLA_SWEEP_TENANT_TIMEOUT_MS = 20_000;
