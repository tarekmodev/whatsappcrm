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
 * Jobs this queue's worker runs in parallel.
 *
 * Four rather than the repo default of one, because the sweep and the
 * per-ticket evaluations share this queue: a sweep walking several slow tenants
 * holds a slot for tens of seconds, and a reconciliation queued behind it can
 * let a ticket breach whose agent had already replied. Four is enough that a
 * single long sweep never blocks the reconciler, and small enough that a
 * recovery burst cannot open more than four transactions at once against the
 * connection budget.
 */
export const SLA_WORKER_CONCURRENCY = 4;

/**
 * How many due timers one sweep claims across every tenant.
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
 * How many of `SLA_SWEEP_BATCH` any **one** tenant may occupy.
 *
 * The fairness half of TAR-381, and the reason phase 1 takes its rows per tenant
 * rather than globally. `ORDER BY due_at LIMIT 200` alone is a starvation hazard
 * whenever one tenant's backlog is both large and old: 200 of its timers fill
 * the batch, they only get *older*, and every sweep from then on returns the
 * same 200 rows — so no other tenant's breaches are examined at all. That is the
 * same failure the `tenants.status = 'active'` term already guards against for
 * deactivated tenants, arriving instead through a tenant whose phase 2 keeps
 * failing, or simply one recovering from a long outage.
 *
 * Capping it makes the guarantee structural rather than probabilistic: at 50
 * against a batch of 200, **at least four tenants are served by every sweep**
 * no matter what any one of them is doing.
 *
 * The cost is drain rate for a single large tenant — 50 per sweep rather than
 * 200, so a 10 000-timer backlog takes ~100 minutes instead of ~25. Against a
 * batch that previously timed out and committed *nothing* (TAR-381), that is a
 * trade worth making. 0006's escalation order still applies when it stops being
 * enough: raise this and `SLA_SWEEP_BATCH` together, then shorten the interval.
 */
export const SLA_SWEEP_TENANT_BATCH = 50;

/**
 * How many of one tenant's timers are claimed and alerted per transaction.
 *
 * The durability half of TAR-381. `claimAndAlert` issues roughly four sequential
 * round-trips per claimed timer, so a transaction covering a tenant's whole
 * batch is hundreds of statements against one timeout — and a transaction that
 * overruns rolls back *everything*, leaving the same rows due for the next
 * sweep to fail on identically. Committing in chunks means partial progress
 * survives: each committed chunk leaves the candidate set for good, so the
 * backlog drains rather than replaying.
 *
 * 25 at roughly four round-trips each is ~100 statements per transaction, which
 * on a healthy database is a couple of seconds against the timeout below.
 */
export const SLA_SWEEP_TENANT_CHUNK = 25;

/**
 * How long one chunk's transaction may take.
 *
 * Prisma's default interactive-transaction timeout is 5 seconds, which is fine
 * for the common case of a handful of timers. This raises it for the recovery
 * case — a full chunk of breached timers, each resolving recipients — while
 * staying far short of the sweep interval, so a stuck tenant fails rather than
 * overlapping the next tick indefinitely. A chunk that does overrun costs that
 * tenant the rest of its chunks this sweep and nothing else.
 */
export const SLA_SWEEP_CHUNK_TIMEOUT_MS = 20_000;
