/**
 * Everything the workflow engine needs that is not a wire value.
 *
 * The queue name, the two job names, the dedupe key and every published shape
 * belong to `@whatsappcrm/contracts/workflows` because they are shared with the
 * modules that enqueue; what is here is local to the worker and the sweep.
 */

/**
 * Stable id for the repeatable elapsed sweep, so a rolling deploy replaces the
 * schedule rather than accumulating one per replica. `QueueService.schedule`
 * wraps `upsertJobScheduler`, which is idempotent on this key.
 */
export const WORKFLOW_SWEEP_SCHEDULE_KEY = 'workflow-sweep';

/**
 * Jobs this queue's worker runs in parallel.
 *
 * Four, matching `SLA_WORKER_CONCURRENCY` and for the same reason: the sweep and
 * the per-ticket evaluations share this queue, and a sweep walking several
 * tenants holds a slot for seconds during which every event-triggered evaluation
 * queues behind it. Unlike the SLA case a delay here cannot produce a *false*
 * result — the claim and the conditions are both re-read at evaluation time —
 * so the cost is latency alone. Four is enough that a long sweep never blocks
 * the evaluator, and small enough that a recovery burst cannot open more than
 * four transactions at once against the connection budget.
 */
export const WORKFLOW_WORKER_CONCURRENCY = 4;

/**
 * How many overdue tickets one sweep enqueues across every tenant.
 *
 * Bounded for the reason `SLA_SWEEP_BATCH` is: after an outage the backlog can
 * be arbitrarily large, and a sweep that took all of it would emit one burst of
 * jobs per tick. Oldest first, capped, every interval — the backlog drains in
 * age order across several sweeps.
 *
 * 0009 decision 3 names the signal that this has stopped being enough: **a full
 * batch returned on consecutive sweeps**. `WorkflowElapsedSweep` logs the batch
 * size on every run that finds work, so the signal exists without extra
 * instrumentation. Raise this and `WORKFLOW_SWEEP_TENANT_BATCH` **together** —
 * per 0006 amendment 1, raising only the batch makes a starving tenant wait
 * longer rather than less.
 */
export const WORKFLOW_SWEEP_BATCH = 200;

/**
 * How many of `WORKFLOW_SWEEP_BATCH` any **one** tenant may occupy.
 *
 * Fairness is structural from the first commit rather than added after an
 * incident, which is the whole lesson of TAR-381. At 50 against a batch of 200,
 * at least four tenants are served by every sweep whatever any one of them is
 * doing.
 *
 * This sweep is cheaper to be fair in than 0006's, because it **writes
 * nothing**: its entire output is jobs, so there is no per-tenant transaction to
 * overrun and no partial progress to lose. A ticket enqueued twice is harmless
 * — the claim is what makes it so.
 */
export const WORKFLOW_SWEEP_TENANT_BATCH = 50;

/**
 * The window the run budget counts over. One hour, matching
 * `WORKFLOW_LIMITS.runsPerTicketPerHour`'s own wording, expressed here in
 * milliseconds because that is what the query needs.
 */
export const WORKFLOW_RUN_BUDGET_WINDOW_MS = 60 * 60 * 1000;

/**
 * ## There is deliberately no per-action timeout constant
 *
 * One was declared here and never read, with a docblock claiming Prisma enforced
 * it — a guard that does not exist is worse than no guard, because the next
 * reader budgets against it.
 *
 * There is also nothing here for it to bound. The executor opens no interactive
 * transaction of its own: the three ticket actions go through
 * `TicketCommandService`, which owns its transactions, and `add_ticket_tag` and
 * `notify` are each a single `createMany`. A timeout belongs on the
 * `$tenantTransaction` that would overrun, which is how
 * `SLA_SWEEP_CHUNK_TIMEOUT_MS` is used — so if a bound is ever wanted here, it
 * goes on that call and not on a constant nothing passes.
 *
 * The real exposure the removed constant gestured at is a `notify` resolving a
 * very large supervisor set holding one of `WORKFLOW_WORKER_CONCURRENCY` slots.
 * That is bounded by the tenant's user count rather than by anything a workflow
 * can say, and it is a query to make cheaper if it ever shows up — not a
 * deadline to invent.
 */
