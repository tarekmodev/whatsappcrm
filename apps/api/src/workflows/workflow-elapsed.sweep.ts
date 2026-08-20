import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  WORKFLOWS_QUEUE,
  WORKFLOW_EVALUATE_TICKET_JOB,
  type WorkflowEvaluateTicketTrigger,
} from '@whatsappcrm/contracts';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';
import { QueueService } from '../queue/queue.service';
import { WORKFLOW_SWEEP_BATCH, WORKFLOW_SWEEP_TENANT_BATCH } from './workflows.constants';

/**
 * Elapsed-trigger detection: the one thing in this feature that nothing calls.
 *
 * "The ticket has been open for four hours" is **a time becoming true, not a
 * request arriving**. Something has to notice, and 0009 decision 3 makes it a
 * bounded per-tenant sweep — fair by construction on day one rather than after
 * an incident, which is the whole lesson of TAR-381.
 *
 * ## The sweep writes nothing
 *
 * Its entire output is jobs. That is what makes it much cheaper to get right
 * than 0006's: there is no per-tenant transaction to overrun, no partial
 * progress to lose, and therefore none of the chunking TAR-381 had to add. The
 * claim in `WorkflowTriggerService` is what makes enqueueing a ticket that has
 * already fired harmless.
 *
 * ## Four properties carried over from 0006 deliberately
 *
 *   1. **The threshold lives in Postgres, and Redis is treated as losable.**
 *      `created_at <= now() - interval` is re-asked from scratch every tick, so
 *      an outage of any length costs lateness and never a missed escalation. A
 *      delayed job per ticket would be a deadline stored in Redis.
 *   2. **Fairness is structural.** At `WORKFLOW_SWEEP_TENANT_BATCH` against
 *      `WORKFLOW_SWEEP_BATCH`, at least four tenants are served by every sweep
 *      whatever any one of them is doing.
 *   3. **Only active tenants are probed**, so a deactivated tenant's backlog can
 *      never own the batch — the case 0006 decision 2 had to close by hand.
 *   4. **Every comparison is Postgres `now()`**, never a node clock.
 *
 * ## Two deliberate divergences from 0009's published SQL
 *
 * Both narrow the query rather than widening it, and both are stated here rather
 * than made quietly.
 *
 *   * **Tenants with no active elapsed workflow are not probed at all.** 0009's
 *     statement probes every active tenant and lets the handler skip. Adding
 *     `EXISTS (SELECT 1 FROM workflows …)` to the outer predicate keeps this one
 *     query, returns the same two uuid columns, and stops a platform where three
 *     tenants use the feature from enqueueing a job per open ticket for all of
 *     them.
 *   * **`$1` is the smallest threshold across the whole fleet**, not per tenant.
 *     0009 writes `$1` as "the smallest `minutes` across the tenant's
 *     elapsed-trigger workflows" while showing a single bind parameter, which
 *     cannot be both. The global minimum is the safe reading — it can only
 *     enqueue *more* than needed, never less — and the per-workflow threshold is
 *     re-checked in the handler against the fact sheet, exactly as 0009
 *     specifies. Reading a per-tenant threshold here would mean pulling workflow
 *     configuration through `SystemPrisma`, which is a wider hole than this
 *     phase is allowed.
 *
 * ## Why `SystemPrisma` at all
 *
 * Phase 1 must find overdue tickets across every tenant, and no request context
 * exists inside a queue worker beyond what the payload names. It is the same
 * narrow exception 0006 decision 2 argues for and `docs/reference/tenancy.md`
 * records: **read-only, two uuid columns, and it reaches no caller.** No
 * subject, no contact, nothing that is a tenant's data. Phase 2 opens a scope
 * per tenant from the ids phase 1 found and does nothing but enqueue.
 */

/** One overdue ticket, as phase 1 sees it: two uuids and nothing else. */
interface OverdueTicketRow {
  readonly tenantId: string;
  readonly id: string;
}

/** What one sweep did, for the log line and for the tests. */
export interface WorkflowSweepReport {
  /** How many overdue tickets phase 1 returned. A full batch is the "falling behind" signal. */
  readonly found: number;
  /** How many evaluation jobs were queued. Lower than `found` means Redis refused some. */
  readonly enqueued: number;
  /** Distinct tenants this sweep touched. */
  readonly tenants: number;
}

const NOTHING_DUE: WorkflowSweepReport = { found: 0, enqueued: 0, tenants: 0 };

@Injectable()
export class WorkflowElapsedSweep {
  private readonly logger = new Logger(WorkflowElapsedSweep.name);

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    private readonly queue: QueueService,
  ) {}

  async sweep(): Promise<WorkflowSweepReport> {
    const startedAt = process.hrtime.bigint();
    const threshold = await this.smallestThresholdMinutes();

    if (threshold === null) {
      // Nobody on the platform has an armed elapsed workflow. The cheapest
      // possible tick, and the common one for a young deployment.
      return NOTHING_DUE;
    }

    const overdue = await this.findOverdueTickets(threshold);

    if (overdue.length === 0) {
      return NOTHING_DUE;
    }

    const report = await this.enqueueAll(overdue);

    // Logged on every run that finds work, because three of the signals 0009
    // asks to be monitored are read off this line: a full batch on consecutive
    // sweeps means detection is falling behind, an `enqueued` below `found`
    // means Redis is refusing, and the elapsed time is 0009 risk 7's named
    // deliverable — the interval is an assumption, and this is the evidence to
    // change it on.
    //
    // Monotonic, so a clock adjustment cannot make a slow sweep look instant.
    this.logger.log(
      `Workflow sweep: ${report.found} overdue across ${report.tenants} tenant(s), ` +
        `${report.enqueued} queued in ${elapsedMs(startedAt)}ms`,
    );

    return report;
  }

  /**
   * The smallest `minutes` any armed elapsed workflow asks for, across the
   * fleet, or `null` when there are none.
   *
   * One integer out of `SystemPrisma`, which is the narrowest possible widening
   * of phase 1's justification: it is an aggregate, it names no tenant, and it
   * reaches no caller. The alternative — probing every tenant at the platform's
   * *lowest possible* threshold of five minutes — would enqueue a job for
   * essentially every open ticket on every tick.
   *
   * `->>'minutes'` is a JSONB extraction, and it is acceptable here where it is
   * not in the evaluation query: this runs once per sweep over the bounded set
   * of elapsed workflows, not once per triggering occurrence, and it sorts
   * nothing.
   */
  private async smallestThresholdMinutes(): Promise<number | null> {
    const [row] = await this.systemPrisma.$queryRaw<{ minutes: number | null }[]>`
      SELECT MIN(((w.definition -> 'trigger' ->> 'minutes')::int)) AS "minutes"
        FROM workflows w
        JOIN tenants n ON n.id = w.tenant_id AND n.status = 'active'
       WHERE w.is_active
         AND w.trigger_type = 'ticket_unresolved_for'
    `;

    return row?.minutes ?? null;
  }

  /**
   * Phase 1. Read-only, two columns, every **active** tenant that has an armed
   * elapsed workflow — and no more than `WORKFLOW_SWEEP_TENANT_BATCH` tickets
   * from any one of them.
   *
   * ## Why it iterates tenants instead of scanning `tickets` globally
   *
   * The obvious statement is `WHERE status IN ('open','pending') AND created_at
   * <= now() - interval ORDER BY created_at LIMIT 200`, and it is unfair in the
   * way TAR-381 proved fatal: an overdue ticket only gets *older*, so one large
   * tenant's backlog owns the head of the sort indefinitely and no other
   * tenant's escalations are ever examined. The `LATERAL` inverts it into one
   * bounded index probe per qualifying tenant, so the batch is shared by
   * construction.
   *
   * ## The index this needs, and why it is not the one 0009 named
   *
   * 0009 writes `tickets (tenant_id, status, created_at)`. TAR-394 shipped a
   * **partial** `(tenant_id, created_at) WHERE status IN ('open','pending')`
   * instead, and that migration's own note gives the reason: with `status` as
   * the second column, two status ranges sit before the column the sweep bounds
   * on, so Postgres would sort the tenant's whole active set instead of stopping
   * at the fiftieth row. The predicate below is written to match that partial
   * index exactly — **changing the status list here without changing the index
   * silently turns this into a sequential scan per tenant.**
   *
   * ## A ticket leaves the candidate set once every elapsed workflow has fired
   *
   * This is the `NOT EXISTS` inside the inner query, and it is **load-bearing
   * rather than an optimisation**. Nothing else takes a ticket out of this set:
   * the sweep writes nothing, an unresolved ticket only gets *older*, and the
   * per-tenant `LIMIT` is ordered oldest-first — so without it, a tenant holding
   * `WORKFLOW_SWEEP_TENANT_BATCH` long-open tickets would return the same fifty
   * rows on every tick for ever, and the fifty-first ticket to cross its
   * threshold would never be enqueued at all. Its escalation would simply never
   * happen, with nothing anywhere reporting it.
   *
   * That is the exact hazard `SlaSweepService`'s docblock says a per-tenant bound
   * does **not** close. The SLA sweep survives it because phase 2 settles each
   * timer out of `state = 'running'`; this sweep has no such write, so the
   * candidate set has to be narrowed by the claim itself.
   *
   * A ticket therefore qualifies only while **some** armed elapsed workflow still
   * has an unspent `ticket:{id}:elapsed` claim on it. Once every one of them has
   * run, the ticket drops out — which is also what stops the fifty ahead of it
   * costing a fact-sheet read per tick for the rest of their lives.
   *
   * ⚠️ That literal is the **only** place this key format is rebuilt in SQL
   * rather than produced by `workflowDedupeKey`, because a correlated subquery
   * cannot call it. The two must move together: a change to the elapsed arm of
   * that function without a change here silently stops the anti-join matching,
   * and the sweep goes back to re-offering tickets that have already fired —
   * which is the starvation this clause exists to prevent, returning quietly.
   * `workflows.test.ts` pins the format from the other side.
   *
   * ## What the anti-join actually costs, which is not what it looks like
   *
   * The `NOT EXISTS` rides `workflow_runs (tenant_id, workflow_id, dedupe_key)`
   * — the same unique index that is the claim — so each probe is cheap. The
   * **number** of probes is the part worth stating honestly, because the obvious
   * reading is wrong: `LIMIT 50` bounds the rows returned, not the rows examined.
   *
   * In the steady state the inner scan walks every open ticket older than the
   * tenant's largest armed threshold before it accumulates fifty qualifying
   * ones, and each already-fired ticket it steps over costs the **maximum**
   * number of probes rather than the minimum — the `EXISTS` can only short-
   * circuit on a workflow that has *not* fired, so a ticket every workflow has
   * already handled is examined once per armed workflow before being rejected.
   *
   * Real bound: O(open tickets older than the largest armed threshold) × armed
   * elapsed workflows, per tenant, per tick — and it is **cheapest when there is
   * work and most expensive on the quiet ticks**, which is the inverse of the
   * profile a reader would assume. It is bounded by
   * `elapsedTriggerWorkflowsPerTenant` only in the second factor.
   *
   * Not changed, because the prefix scan is what makes it correct and the
   * alternatives — a watermark column on `tickets` — trade away "the sweep writes
   * nothing", which is the property the rest of this class is built on. The
   * instrumentation to notice already exists: `sweep()` logs elapsed time on
   * every run that finds work. Stated rather than left to be measured, for the
   * same reason `WORKFLOW_ACTION_TIMEOUT_MS` was deleted — the next reader will
   * budget against whatever number is written here.
   *
   * The statement still returns two uuid columns and still reaches no caller.
   */
  private async findOverdueTickets(thresholdMinutes: number): Promise<OverdueTicketRow[]> {
    return await this.systemPrisma.$queryRaw<OverdueTicketRow[]>`
      SELECT d."tenantId", d.id
        FROM tenants n
        CROSS JOIN LATERAL (
          SELECT t.tenant_id AS "tenantId", t.id, t.created_at
            FROM tickets t
           WHERE t.tenant_id = n.id
             AND t.status IN ('open', 'pending')
             AND t.created_at <= now() - make_interval(mins => ${thresholdMinutes})
             AND EXISTS (
               SELECT 1
                 FROM workflows aw
                WHERE aw.tenant_id = n.id
                  AND aw.is_active
                  AND aw.trigger_type = 'ticket_unresolved_for'
                  AND NOT EXISTS (
                    SELECT 1
                      FROM workflow_runs r
                     WHERE r.tenant_id = n.id
                       AND r.workflow_id = aw.id
                       AND r.dedupe_key = 'ticket:' || t.id || ':elapsed'
                  )
             )
           ORDER BY t.created_at
           LIMIT ${WORKFLOW_SWEEP_TENANT_BATCH}
        ) d
       WHERE n.status = 'active'
         AND EXISTS (
           SELECT 1
             FROM workflows w
            WHERE w.tenant_id = n.id
              AND w.is_active
              AND w.trigger_type = 'ticket_unresolved_for'
         )
       ORDER BY d.created_at
       LIMIT ${WORKFLOW_SWEEP_BATCH}
    `;
  }

  /**
   * Phase 2: one `workflow.evaluate-ticket` job per pair, and nothing else.
   *
   * No tenant scope is opened and no transaction is taken, because nothing is
   * read or written — the job payload names its tenant and the worker sets its
   * own scope from it before its first statement. `depth: 0` and
   * `causedByRunId: null` because a clock did this, not a workflow.
   *
   * A refused enqueue is logged and counted, never thrown: the next sweep
   * re-derives the same ticket from `created_at`, so an outage costs lateness
   * and nothing else. That self-healing is exactly what event triggers do not
   * have (0009, risk 3).
   */
  private async enqueueAll(overdue: readonly OverdueTicketRow[]): Promise<WorkflowSweepReport> {
    const tenants = new Set<string>();
    let enqueued = 0;

    for (const ticket of overdue) {
      tenants.add(ticket.tenantId);

      const trigger: WorkflowEvaluateTicketTrigger = {
        tenantId: ticket.tenantId,
        ticketId: ticket.id,
        triggerType: 'ticket_unresolved_for',
        // The dedupe key for this trigger is the ticket itself — once per
        // ticket, ever — so there is no occurrence row to name.
        occurrenceId: null,
        depth: 0,
        causedByRunId: null,
      };

      const outcome = await this.queue.enqueue<WorkflowEvaluateTicketTrigger>(
        WORKFLOWS_QUEUE,
        WORKFLOW_EVALUATE_TICKET_JOB,
        trigger,
        {
          // No custom `jobId`. A ticket-keyed id would be dropped for ever
          // behind the completed — or, worse, *failed* — key of a previous
          // sweep's job for the same ticket, which is an escalation that never
          // happens. See the note in `@whatsappcrm/contracts/workflows`.
          attempts: 3,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      );

      if (outcome === 'added' || outcome === 'duplicate') {
        enqueued += 1;
      }
    }

    return { found: overdue.length, enqueued, tenants: tenants.size };
  }
}

/** Whole milliseconds since `startedAt`, off the monotonic clock. */
function elapsedMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}
