import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  WORKFLOWS_QUEUE,
  WORKFLOW_EVALUATE_TICKET_JOB,
  type SlaTargetKind,
  type WorkflowEvaluateTicketTrigger,
} from '@whatsappcrm/contracts';
import { randomUUID } from 'node:crypto';
import { describeFailure } from '../common/describe-failure';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { SLA_BREACHED_EVENT, type SlaBreachedEvent } from '../events/domain-events';
import { Prisma } from '../generated/prisma/client';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import {
  SYSTEM_PRISMA,
  TENANT_PRISMA,
  type SystemPrisma,
  type TenantPrisma,
} from '../prisma/prisma.tokens';
import { QueueService } from '../queue/queue.service';
import { SlaAlertService, type InsertedSlaAlert } from './sla-alert.service';
import { SlaTimerService } from './sla-timer.service';
import {
  SLA_SWEEP_BATCH,
  SLA_SWEEP_CHUNK_TIMEOUT_MS,
  SLA_SWEEP_TENANT_BATCH,
  SLA_SWEEP_TENANT_CHUNK,
} from './sla.constants';

/**
 * Breach detection: the one thing in this feature that nothing calls.
 *
 * A breach is **a time becoming true, not a request arriving**. Something has to
 * notice, exactly once per transition, across replicas, restarts and a Redis
 * outage — while every read and write stays inside one tenant. This is that
 * something, and it implements decisions 1–3 of 0006 directly.
 *
 * ## Decision 1 — a periodic sweep, not a job scheduled per timer
 *
 * A delayed BullMQ job per timer would be precise to the second and is the
 * better mechanism if the deadline were durable where the job is. It is not:
 * the deadline lives in Postgres and Redis is treated as losable throughout this
 * codebase, so a flush would lose breaches with no error, no retry and no failed
 * set — an alert that simply never comes. `due_at` also **moves**, on every
 * pause and resume, and a stale scheduled job that escaped cancellation fires
 * early, which is a *false* breach alert and worse than a late one.
 *
 * The predicate is `due_at <= now()` rather than "due since the last tick", so
 * catch-up after an outage of any length is free: the first sweep drains the
 * backlog with no re-arming and no bookkeeping of what was missed. The cost,
 * stated plainly, is detection latency bounded by the sweep interval — 30
 * seconds against a 60-minute window.
 *
 * ## Decision 2 — two phases, and only the first is unscoped
 *
 * Phase 1 must find due timers across every tenant, and no request context
 * exists inside a queue worker beyond what the payload names. It therefore runs
 * on `SystemPrisma` — the sixth call site 0002 permits, and this is its
 * justification: it is **read-only, returns two uuid columns, and reaches no
 * caller**. No ticket, no contact, no message, nothing that is a tenant's data.
 *
 * Phase 2 groups those pairs by tenant and does every read and every write
 * inside one `$tenantTransaction` per tenant, under RLS. That split is the
 * point: the writes are the dangerous half, and an alert row inserted with the
 * wrong `tenant_id` under the system role is a cross-tenant leak RLS would
 * otherwise have refused.
 *
 * ## The claim does not trust a job to have run (TAR-380)
 *
 * `state = 'running'` is only the right predicate if something reliably moved a
 * timer out of `running` the moment its target was met. Nothing does:
 * `SlaTimerService` is reached by a queue job, and `QueueService.enqueue` is
 * contractually allowed to report `failed` or `unavailable` and drop it — a
 * two-second Redis blip is enough. An agent who replied at minute 40 of a
 * 60-minute window would then have their ticket flipped to `breached` by the
 * next sweep, terminally, and a supervisor alerted about a ticket answered
 * twenty minutes early.
 *
 * So phase 2 **re-derives the state of every due ticket first**, in the same
 * transaction it claims in, through `SlaTimerService.reconcile` — the same code
 * the dropped job would have run. A ticket that was answered, resolved, closed
 * or paused reaches `met`/`cancelled`/`paused` there and the claim below no
 * longer matches it; one that is genuinely overdue is left `running` and
 * breaches. Re-deriving rather than adding a second reply check to the claim's
 * SQL is deliberate: "has a person replied" is a question with one answer in
 * this codebase, and two implementations of it would drift.
 *
 * It also has to *settle* those timers rather than merely skip them. A timer the
 * claim declined would stay `running` and past due, and an unclaimed timer only
 * gets *older* — so it leads its tenant's slice of every subsequent batch for
 * ever. TAR-381's per-tenant bound below contains the damage to one tenant
 * rather than the platform, and that is exactly what makes skipping worse rather
 * than acceptable: a handful of permanently-declined timers would occupy that
 * tenant's whole `SLA_SWEEP_TENANT_BATCH` allowance and its *real* breaches
 * would never be examined, reported as nothing at all.
 *
 * ## Decision 3 — the state transition is the idempotency mechanism
 *
 * The claim is a conditional `UPDATE … WHERE state = 'running'`, and **only the
 * rows this statement moved are alerted**. Two replicas sweeping the same timer:
 * one gets the row, the other gets none. The `UNIQUE (tenant_id, sla_timer_id,
 * recipient_user_id)` index is the second layer, covering a retry after a
 * partial failure. Nothing here reads, decides in TypeScript, and then writes —
 * the window between such a read and its write is exactly the window two
 * replicas race in, and the bug it produces is a duplicate alert every 30
 * seconds.
 *
 * `ticket_events` has no unique constraint and cannot easily grow one on an
 * append-only log. That is precisely why the audit row is written in the **same
 * transaction as the flip** rather than in a downstream job: the `state =
 * 'running'` guard is what makes it run at most once.
 *
 * ## The emit happens after the commit, and only for rows that were inserted
 *
 * If the process dies between commit and emit, the alert row exists and the
 * supervisor sees it on their next page load. The row is the record; the socket
 * is an accelerator. That asymmetry is deliberate and is the reason decision 5
 * writes a row at all.
 *
 * ## No tenant can starve the others (TAR-381)
 *
 * The predicate that makes catch-up free — `due_at <= now()`, oldest first — is
 * also what makes a stuck tenant contagious, because a timer that is never
 * claimed only gets *older* and therefore sorts to the head of every subsequent
 * batch. A global `ORDER BY due_at LIMIT 200` hands the whole batch to one
 * tenant's backlog for as long as that backlog exists, and platform-wide
 * detection stops with nothing louder than one warning per tick.
 *
 * Two bounds close that, and both are needed:
 *
 *   * **Phase 1 takes at most `SLA_SWEEP_TENANT_BATCH` rows per tenant**, so the
 *     batch is shared by construction. Four tenants minimum are served by every
 *     sweep however badly any one of them is behaving — including a tenant whose
 *     phase 2 fails every single time, which no amount of chunking would help.
 *   * **Phase 2 commits in chunks of `SLA_SWEEP_TENANT_CHUNK`**, so a
 *     transaction that overruns its timeout costs that tenant the rest of this
 *     sweep rather than all of it. Without this a timeout rolls back every
 *     claim, and the identical rows lead the next sweep into the identical
 *     timeout — a livelock that reports itself only as a warning.
 */

/**
 * One breach this sweep committed: the ticket, the timer that missed, and the
 * alert rows it actually inserted.
 *
 * `slaTimerId` is carried because it is the **occurrence** a `ticket_sla_breached`
 * workflow dedupes on — `ticket:{id}:timer:{slaTimerId}`, once per breached
 * timer (0009, decision 2). Without it the trigger would have to key on the
 * ticket, and a ticket whose first-response and resolution timers both breach
 * would fire the workflow once instead of twice.
 */
interface BreachRecord {
  readonly ticketId: string;
  readonly slaTimerId: string;
  readonly alerts: InsertedSlaAlert[];
}

/** One due timer, as phase 1 sees it: two uuids and nothing else. */
interface DueTimerRow {
  readonly tenantId: string;
  readonly id: string;
}

/** One timer this sweep claimed — the rows the conditional UPDATE returned. */
interface ClaimedTimerRow {
  readonly id: string;
  readonly ticketId: string;
  readonly kind: SlaTargetKind;
  readonly dueAt: Date;
}

/** What one sweep did, for the runner's log line and for the tests. */
export interface SlaSweepReport {
  /** How many due timers phase 1 returned. A full batch is the "falling behind" signal. */
  readonly due: number;
  /** How many timers this sweep flipped to `breached`. */
  readonly breached: number;
  /** How many `notifications` rows were written. Zero with breaches means no supervisor. */
  readonly alerted: number;
  /** Tenants skipped because they are deactivated. Not a fault. */
  readonly skippedTenants: number;
  /** Tenants whose phase 2 failed. Quarantined, so one cannot fail the rest. */
  readonly failedTenants: number;
}

/**
 * What one tenant's chunks added up to, and whether anything cut them short.
 *
 * The counts are of **committed** work only, so a tenant that stopped part-way
 * still reports the chunks that landed — which is the whole point of chunking.
 */
interface TenantSweepOutcome {
  readonly breached: number;
  readonly alerted: number;
  /** Why the tenant stopped: `'nothing'` means it worked through every chunk. */
  readonly stoppedBy: 'nothing' | 'deactivation' | 'failure';
}

@Injectable()
export class SlaSweepService {
  private readonly logger = new Logger(SlaSweepService.name);

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly timers: SlaTimerService,
    private readonly alerts: SlaAlertService,
    private readonly events: EventEmitter2,
    private readonly queue: QueueService,
  ) {}

  async sweep(): Promise<SlaSweepReport> {
    const startedAt = process.hrtime.bigint();
    const due = await this.findDueTimers();

    if (due.length === 0) {
      return { due: 0, breached: 0, alerted: 0, skippedTenants: 0, failedTenants: 0 };
    }

    const report = await this.breachByTenant(groupByTenant(due));

    // Logged on every run that finds work, because three of the four things 0006
    // says should page someone are read off this line: a full batch on
    // consecutive sweeps means detection is falling behind, breaches with no
    // alerts means a tenant has nobody to tell, and the elapsed time is 0006's
    // named deliverable for spotting a sweep that is overrunning its 30-second
    // interval *before* the overrun turns into the livelock TAR-381 fixed.
    //
    // Monotonic, so a clock adjustment cannot make a slow sweep look instant.
    this.logger.log(
      `SLA sweep: ${report.due} due, ${report.breached} breached, ${report.alerted} alerts` +
        (report.skippedTenants > 0 ? `, ${report.skippedTenants} tenant(s) inactive` : '') +
        (report.failedTenants > 0 ? `, ${report.failedTenants} tenant(s) failed` : '') +
        ` in ${elapsedMs(startedAt)}ms`,
    );

    return report;
  }

  /**
   * Phase 1. Read-only, two columns, every **active** tenant — and no more than
   * `SLA_SWEEP_TENANT_BATCH` of them from any one tenant.
   *
   * `now()` is Postgres's, never a node clock: skew between API instances must
   * not be able to breach a timer early or hold one open.
   *
   * ## Why it iterates tenants instead of scanning `sla_timers` globally
   *
   * The obvious statement is `WHERE state = 'running' AND due_at <= now() ORDER
   * BY due_at LIMIT 200` against `sla_timers_state_due_at_idx`, and it is the
   * cheaper one: the scan stops at the first row not yet due, so its cost grows
   * with the number of *running* timers rather than with the number due. It is
   * also unfair in a way that is fatal here (TAR-381). A timer that is not
   * claimed only gets older, so any tenant whose phase 2 keeps failing — or that
   * is simply recovering from an outage with a full batch of overdue work — owns
   * the head of the sort indefinitely, and no other tenant's breaches are
   * examined at all. The `n.status = 'active'` term below closes exactly one
   * instance of that (a deactivated tenant, whose timers phase 2 can *never*
   * claim); it does nothing about the rest.
   *
   * The `LATERAL` inverts it: one bounded, per-tenant index probe served by
   * `sla_timers (tenant_id, state, due_at)`, so a tenant contributes at most its
   * cap and the batch is shared by construction. The cost is one index probe per
   * active tenant per sweep — a lookup that returns nothing for the tenants with
   * no due work, which is almost all of them on almost every tick — against a
   * `tenants` table that is small by definition. Rows materialised before the
   * outer sort are therefore bounded by `active tenants × SLA_SWEEP_TENANT_BATCH`
   * rather than by the size of the platform's backlog.
   *
   * The outer `ORDER BY due_at` is unchanged, so within the batch the oldest
   * deadline is still processed first.
   *
   * ## Why the join to `tenants`, and why it is not optional
   *
   * A deactivated tenant's timers cannot be swept: phase 2 opens a
   * `$tenantTransaction`, `assert_tenant_active` raises before `set_config`
   * runs, and the claim never executes — so those rows stay `running` for ever
   * while getting steadily older. The status term is the same one
   * `assert_tenant_active` enforces, so this cannot admit a row phase 2 would
   * then refuse. Phase 2 keeps its `TenantNotActiveError` branch regardless: a
   * tenant deactivated in the gap between the two phases is a race this narrows
   * rather than closes.
   *
   * `tenants.status` is not a tenant's business data, and this statement still
   * returns nothing but uuid pairs — the read-only, two-column, reaches-no-caller
   * shape that is the whole justification for phase 1 running on `SystemPrisma`.
   */
  private async findDueTimers(): Promise<DueTimerRow[]> {
    return await this.systemPrisma.$queryRaw<DueTimerRow[]>`
      SELECT d."tenantId", d.id
        FROM tenants n
        CROSS JOIN LATERAL (
          SELECT t.tenant_id AS "tenantId", t.id, t.due_at
            FROM sla_timers t
           WHERE t.tenant_id = n.id AND t.state = 'running' AND t.due_at <= now()
           ORDER BY t.due_at
           LIMIT ${SLA_SWEEP_TENANT_BATCH}
        ) d
       WHERE n.status = 'active'
       ORDER BY d.due_at
       LIMIT ${SLA_SWEEP_BATCH}
    `;
  }

  /**
   * Phase 2, one tenant at a time.
   *
   * Failures are quarantined per tenant rather than aborting the sweep. A
   * deactivated tenant is not a fault at all — `assert_tenant_active` refuses
   * every statement, which is a state an operator deliberately created (TAR-51)
   * — and any other failure is one tenant's problem that must not cost every
   * other tenant their detection for this tick. The next sweep retries both, at
   * no extra cost, because the predicate is `due_at <= now()`.
   */
  private async breachByTenant(byTenant: Map<string, string[]>): Promise<SlaSweepReport> {
    let breached = 0;
    let alerted = 0;
    let skippedTenants = 0;
    let failedTenants = 0;
    let due = 0;

    for (const [tenantId, timerIds] of byTenant) {
      due += timerIds.length;

      const outcome = await this.breachForTenant(tenantId, timerIds);

      breached += outcome.breached;
      alerted += outcome.alerted;

      if (outcome.stoppedBy === 'deactivation') {
        skippedTenants += 1;
      } else if (outcome.stoppedBy === 'failure') {
        failedTenants += 1;
      }
    }

    return { due, breached, alerted, skippedTenants, failedTenants };
  }

  /**
   * One tenant's whole phase 2, as several transactions rather than one.
   *
   * The chunk is the unit of durability (TAR-381): every committed chunk takes
   * its timers out of the candidate set for good, so a tenant that overruns on
   * its third chunk keeps the first two and starts the next sweep that much
   * further ahead. One transaction for the lot rolls back all of it and leaves
   * the identical rows to fail identically for ever.
   *
   * The first chunk to fail ends the tenant's turn: whatever refused it — a
   * deactivation, an unreachable database, a transaction that will not fit the
   * timeout — is not going to behave differently for the chunk behind it, and
   * spending the rest of the sweep's wall-clock proving that costs every tenant
   * after this one in the loop.
   */
  private async breachForTenant(
    tenantId: string,
    timerIds: readonly string[],
  ): Promise<TenantSweepOutcome> {
    let breached = 0;
    let alerted = 0;

    for (const chunk of chunked(timerIds, SLA_SWEEP_TENANT_CHUNK)) {
      try {
        const committed = await this.breachChunk(tenantId, chunk);

        breached += committed.breached;
        alerted += committed.alerted;
      } catch (error: unknown) {
        if (error instanceof TenantNotActiveError) {
          this.logger.warn(`Skipped SLA sweep for deactivated tenant ${tenantId}`);

          return { breached, alerted, stoppedBy: 'deactivation' };
        }

        this.logger.error(
          `SLA sweep failed for tenant ${tenantId} after ${breached} committed breach(es); ` +
            `the next sweep will retry the rest: ${describeFailure(error)}`,
        );

        return { breached, alerted, stoppedBy: 'failure' };
      }
    }

    return { breached, alerted, stoppedBy: 'nothing' };
  }

  /** One chunk of one tenant's timers, in one transaction, then its emits. */
  private async breachChunk(
    tenantId: string,
    timerIds: readonly string[],
  ): Promise<{ breached: number; alerted: number }> {
    const breaches = await this.tenantContext.run(
      // A scope of its own, from the id phase 1 returned — the same thing a
      // queue worker does with its payload. Nothing is borrowed from the job's
      // scope, which names no tenant: the sweep job is tenant-less by design.
      { requestId: `sla-sweep:${randomUUID()}`, tenantId, userId: null, principal: null },
      async () =>
        await this.prisma.$tenantTransaction(
          async (tx) => await this.claimAndAlert(tx, tenantId, timerIds),
          { timeout: SLA_SWEEP_CHUNK_TIMEOUT_MS },
        ),
    );

    for (const breach of breaches) {
      // 0009 delta 3: one `ticket_sla_breached` occurrence per breached timer,
      // after the transaction that flipped it has committed. Raised for **every**
      // committed breach, including one with no supervisor to alert — a workflow
      // reacting to a breach is a separate concern from telling a person about
      // it, and a tenant with no active supervisor is exactly the tenant most
      // likely to have automated the response.
      await this.triggerWorkflowEvaluation(tenantId, breach);

      if (breach.alerts.length === 0) {
        continue;
      }

      const event: SlaBreachedEvent = {
        tenantId,
        ticketId: breach.ticketId,
        alertIds: breach.alerts.map((alert) => alert.id),
      };

      this.events.emit(SLA_BREACHED_EVENT, event);
    }

    return {
      breached: breaches.length,
      alerted: breaches.reduce((total, breach) => total + breach.alerts.length, 0),
    };
  }

  /**
   * 0009 delta 3 — the fourth producer of a workflow triggering occurrence.
   *
   * An enqueue after commit, never a call: `WorkflowsModule` is a sibling L4
   * module, so what crosses the line is the payload in
   * `@whatsappcrm/contracts/workflows` and a queue name. A refused enqueue is
   * logged and swallowed, on `QueueService`'s contract — the breach itself is
   * committed and the sweep's other tenants are still owed their tick.
   *
   * **This is the one trigger with no reconciler and no self-healing** (0009,
   * risk 3): the timer is terminally `breached`, so nothing re-derives it. A
   * Redis outage in this window costs that ticket its automation permanently.
   */
  private async triggerWorkflowEvaluation(tenantId: string, breach: BreachRecord): Promise<void> {
    const trigger: WorkflowEvaluateTicketTrigger = {
      tenantId,
      ticketId: breach.ticketId,
      triggerType: 'ticket_sla_breached',
      occurrenceId: breach.slaTimerId,
      depth: 0,
      causedByRunId: null,
    };

    const outcome = await this.queue.enqueue<WorkflowEvaluateTicketTrigger>(
      WORKFLOWS_QUEUE,
      WORKFLOW_EVALUATE_TICKET_JOB,
      trigger,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Ticket ${breach.ticketId} breached timer ${breach.slaTimerId} but its workflow ` +
          `evaluation was not queued (${outcome}); no automation will run for this breach.`,
      );
    }
  }

  /**
   * One chunk of one tenant's phase 2, in one transaction: reconcile, claim,
   * audit, deliver.
   */
  private async claimAndAlert(
    tx: Prisma.TransactionClient,
    tenantId: string,
    timerIds: readonly string[],
  ): Promise<BreachRecord[]> {
    await this.reconcileDueTickets(tx, tenantId, timerIds);

    const claimed = await this.claim(tx, timerIds);
    const breaches: BreachRecord[] = [];

    if (claimed.length === 0) {
      return breaches;
    }

    // Once per transaction, not once per breach: the tenant's supervisors and
    // admins do not change while this transaction runs, and a full chunk would
    // otherwise issue `SLA_SWEEP_TENANT_CHUNK` identical queries inside it.
    const candidates = await this.alerts.loadAlertCandidates(tx);

    for (const timer of claimed) {
      // In the same transaction as the flip, which is what bounds it to one:
      // `ticket_events` is append-only with no unique constraint, so the
      // `state = 'running'` guard above is the only thing that can.
      await tx.ticketEvent.create({
        data: {
          tenantId,
          ticketId: timer.ticketId,
          type: 'sla_breached',
          // Null actor: the system missed this, not a person.
          data: { kind: timer.kind, dueAt: timer.dueAt.toISOString() },
        },
        select: { id: true },
      });

      const ticket = await tx.ticket.findUnique({
        where: { id: timer.ticketId },
        select: { assignedUserId: true, assignedTeamId: true },
      });

      if (ticket === null) {
        // The composite foreign key makes this unreachable while the timer
        // exists. Loud rather than silent if it ever is: a breach with no ticket
        // is a schema invariant that stopped holding.
        this.logger.error(`Timer ${timer.id} breached but its ticket ${timer.ticketId} is gone`);
        continue;
      }

      const recipientUserIds = await this.alerts.resolveRecipients(tx, candidates, ticket);

      if (recipientUserIds.length === 0) {
        // 0004's `last_admin_required` guarantees every tenant keeps one active
        // admin, so this is theoretical rather than real — but "nobody was told"
        // is exactly the failure that must not be silent. The ticket still shows
        // overdue in the queue.
        this.logger.warn(
          `Ticket ${timer.ticketId} breached in tenant ${tenantId} with no active supervisor or admin to alert`,
        );
        breaches.push({ ticketId: timer.ticketId, slaTimerId: timer.id, alerts: [] });
        continue;
      }

      breaches.push({
        ticketId: timer.ticketId,
        slaTimerId: timer.id,
        alerts: await this.alerts.insertForBreach(tx, {
          tenantId,
          slaTimerId: timer.id,
          ticketId: timer.ticketId,
          kind: timer.kind,
          dueAt: timer.dueAt,
          recipientUserIds,
        }),
      });
    }

    return breaches;
  }

  /**
   * Brings every ticket with a due timer up to date **before** the claim reads
   * their state, so a breach is decided against the ticket rather than against
   * whether a queue job happened to survive Redis (TAR-380).
   *
   * This is the same `SlaTimerService` body the `sla.evaluate-ticket` handler
   * runs, called here on the chunk's own transaction — inside it rather than
   * before it, so the claim below reads a state this transaction wrote and no
   * reply can land in a gap between the two.
   *
   * ## What it costs, on each of the two paths
   *
   * A ticket that really is overdue — the overwhelming majority, because a
   * dropped trigger is the exception — costs three reads and issues no write, so
   * the ordinary sweep adds at most `SLA_SWEEP_TENANT_CHUNK` × 3 round trips
   * inside `SLA_SWEEP_CHUNK_TIMEOUT_MS` and takes nothing another transaction
   * could be waiting on.
   *
   * A ticket that was answered, resolved, closed or paused while its trigger was
   * lost gets exactly the transition that trigger would have applied — and that
   * path **writes, so it holds row locks on `tickets` and `sla_timers` until
   * this chunk commits**. That is the price of repairing the row rather than
   * skipping it, and it is why the scan below is ordered.
   *
   * ## Why `ORDER BY ticket_id`
   *
   * `DISTINCT` guarantees no ordering, and `reconcile` locks a ticket's rows in
   * a fixed sequence within one call — so ordering the tickets is enough to make
   * the whole loop's lock order total. Without it, two sweeps whose chunks
   * overlap on the same two tickets can take them in opposite orders and
   * deadlock; Postgres kills one, the chunk rolls back, and the tenant is
   * counted as a failure for the tick. The sort costs at most
   * `SLA_SWEEP_TENANT_CHUNK` uuids.
   *
   * Note this orders the *repair* path against itself. It is not needed against
   * the claim, which uses `FOR UPDATE SKIP LOCKED` and steps aside rather than
   * waiting.
   *
   * **Do not delete it as redundant** on the evidence of an `EXPLAIN`. Postgres
   * currently plans this `DISTINCT` as `Sort → Unique` keyed on `ticket_id`, so
   * the rows come back ordered whether or not the clause is written — which is
   * also why no test in this repo can fail when it is removed. `HashAggregate`
   * is an equally valid plan for the same query and returns groups in no order
   * at all; the planner picks between them on row-count estimates and
   * `work_mem`. The clause is the guarantee, the current plan is a coincidence,
   * and the failure the coincidence hides is an intermittent deadlock under
   * concurrency.
   *
   * ## Why the ids are read here
   *
   * Rather than returned by phase 1: phase 1 is the one unscoped statement in
   * this file and stays two uuid columns wide. This read is inside the tenant
   * transaction, under RLS, and `DISTINCT` collapses a ticket whose
   * first-response and resolution timers are both due into one reconciliation.
   *
   * A timer whose ticket is gone is unreachable while the composite foreign key
   * holds; if it ever happens `reconcile` raises `SlaTicketNotVisibleError`, the
   * chunk is rolled back, and the caller ends the tenant's turn with the earlier
   * chunks committed rather than failing silently.
   */
  private async reconcileDueTickets(
    tx: Prisma.TransactionClient,
    tenantId: string,
    timerIds: readonly string[],
  ): Promise<void> {
    const ticketIds = await tx.$queryRaw<{ ticketId: string }[]>`
      SELECT DISTINCT ticket_id AS "ticketId"
        FROM sla_timers
       WHERE id IN (${idList(timerIds)}) AND state = 'running' AND due_at <= now()
       ORDER BY ticket_id
    `;

    for (const { ticketId } of ticketIds) {
      await this.timers.reconcile(tx, tenantId, ticketId);
    }
  }

  /**
   * The claim (0006, decision 3, statement 1). **Only rows this statement moved
   * are returned**, and therefore only they are alerted.
   *
   * `FOR UPDATE SKIP LOCKED` so a concurrent sweep holding a row does not block
   * this one: it takes what it can and leaves the rest to whoever holds them,
   * which is the same shape the webhook claim uses.
   *
   * The predicate is re-checked here rather than trusted from phase 1 — `state =
   * 'running' AND due_at <= now()` — because between the two an agent may have
   * replied (the timer is `met`) or the ticket may have been paused and resumed
   * (the deadline moved forward). Trusting the phase-1 read would alert a
   * supervisor about a deadline that no longer exists.
   *
   * What makes that re-check sufficient rather than wishful is
   * `reconcileDueTickets` above, which has already put each of these tickets'
   * timers into the state the ticket implies — inside this transaction, so the
   * `state = 'running'` predicate reads the reconciled value.
   */
  private async claim(
    tx: Prisma.TransactionClient,
    timerIds: readonly string[],
  ): Promise<ClaimedTimerRow[]> {
    return await tx.$queryRaw<ClaimedTimerRow[]>`
      WITH due AS (
        SELECT id
          FROM sla_timers
         WHERE id IN (${idList(timerIds)}) AND state = 'running' AND due_at <= now()
           FOR UPDATE SKIP LOCKED
      )
      UPDATE sla_timers t
         SET state = 'breached', breached_at = now()
        FROM due
       WHERE t.id = due.id
      RETURNING t.id AS "id", t.ticket_id AS "ticketId", t.kind::text AS "kind", t.due_at AS "dueAt"
    `;
  }
}

/** Whole milliseconds since `startedAt`, off the monotonic clock. */
function elapsedMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

/** The chunks one tenant's ids are committed in, in order, never empty. */
function* chunked<T>(values: readonly T[], size: number): Generator<readonly T[]> {
  for (let index = 0; index < values.length; index += size) {
    yield values.slice(index, index + size);
  }
}

/**
 * The batch's ids as a bound `IN` list — one parameter per id, cast to `uuid` so
 * the comparison uses the index rather than a text coercion. Written once
 * because both statements phase 2 sends are scoped to the same batch, and
 * because an id interpolated into the SQL rather than bound would be the
 * injection hole this file must not have.
 */
function idList(ids: readonly string[]): Prisma.Sql {
  return Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
}

/**
 * Phase 1's flat list, grouped into the transactions phase 2 opens. Insertion
 * order is preserved, so the tenant whose oldest deadline came back first is
 * processed first — a sweep that hits its batch limit works through the backlog
 * in breach order rather than in tenant-id order.
 */
function groupByTenant(rows: readonly DueTimerRow[]): Map<string, string[]> {
  const byTenant = new Map<string, string[]>();

  for (const row of rows) {
    const existing = byTenant.get(row.tenantId);

    if (existing === undefined) {
      byTenant.set(row.tenantId, [row.id]);
      continue;
    }

    existing.push(row.id);
  }

  return byTenant;
}
