import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { SlaTargetKind } from '@whatsappcrm/contracts';
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
import { SlaAlertService, type InsertedSlaAlert } from './sla-alert.service';
import { SLA_SWEEP_BATCH, SLA_SWEEP_TENANT_TIMEOUT_MS } from './sla.constants';

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
 */

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
  /** How many `sla_alerts` rows were written. Zero with breaches means no supervisor. */
  readonly alerted: number;
  /** Tenants skipped because they are deactivated. Not a fault. */
  readonly skippedTenants: number;
  /** Tenants whose phase 2 failed. Quarantined, so one cannot fail the rest. */
  readonly failedTenants: number;
}

@Injectable()
export class SlaSweepService {
  private readonly logger = new Logger(SlaSweepService.name);

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly alerts: SlaAlertService,
    private readonly events: EventEmitter2,
  ) {}

  async sweep(): Promise<SlaSweepReport> {
    const due = await this.findDueTimers();

    if (due.length === 0) {
      return { due: 0, breached: 0, alerted: 0, skippedTenants: 0, failedTenants: 0 };
    }

    const report = await this.breachByTenant(groupByTenant(due));

    // Logged on every run that finds work, because two of the three things 0006
    // says should page someone are read off this line: a full batch on
    // consecutive sweeps means detection is falling behind, and breaches with no
    // alerts means a tenant has nobody to tell.
    this.logger.log(
      `SLA sweep: ${report.due} due, ${report.breached} breached, ${report.alerted} alerts` +
        (report.skippedTenants > 0 ? `, ${report.skippedTenants} tenant(s) inactive` : '') +
        (report.failedTenants > 0 ? `, ${report.failedTenants} tenant(s) failed` : ''),
    );

    return report;
  }

  /**
   * Phase 1. Read-only, two columns, every **active** tenant.
   *
   * `ORDER BY due_at` with a `LIMIT` is what makes the scan stop at the first row
   * that is not yet due, so the cost grows with the number of *running* timers
   * rather than with the number due — served by `sla_timers_state_due_at_idx`,
   * the one composite index in the schema that does not lead with `tenant_id`.
   *
   * `now()` is Postgres's, never a node clock: skew between API instances must
   * not be able to breach a timer early or hold one open.
   *
   * ## Why the join to `tenants`, and why it is not optional
   *
   * A deactivated tenant's timers cannot be swept: phase 2 opens a
   * `$tenantTransaction`, `assert_tenant_active` raises before `set_config`
   * runs, and the claim never executes — so those rows stay `running` for ever.
   * They also only get *older*, so `ORDER BY due_at` sorts them to the head of
   * every batch. Without this filter, one deactivated tenant holding 200 overdue
   * timers fills the batch on every sweep from then on and **no other tenant's
   * breaches are ever examined** — platform-wide detection stops, reported only
   * as a warning line about a skipped tenant.
   *
   * The status term is the same one `assert_tenant_active` enforces, so this
   * cannot admit a row phase 2 would then refuse. Phase 2 keeps its
   * `TenantNotActiveError` branch regardless: a tenant deactivated in the gap
   * between the two phases is a race this narrows rather than closes.
   *
   * The join costs a primary-key lookup per candidate row and reaches no tenant
   * data — `tenants.status` is not a tenant's business data, and this statement
   * still returns nothing but uuid pairs.
   */
  private async findDueTimers(): Promise<DueTimerRow[]> {
    return await this.systemPrisma.$queryRaw<DueTimerRow[]>`
      SELECT t.tenant_id AS "tenantId", t.id
        FROM sla_timers t
        JOIN tenants n ON n.id = t.tenant_id
       WHERE t.state = 'running' AND t.due_at <= now() AND n.status = 'active'
       ORDER BY t.due_at
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

      try {
        const outcome = await this.breachForTenant(tenantId, timerIds);

        breached += outcome.breached;
        alerted += outcome.alerted;
      } catch (error: unknown) {
        if (error instanceof TenantNotActiveError) {
          this.logger.warn(`Skipped SLA sweep for deactivated tenant ${tenantId}`);
          skippedTenants += 1;
          continue;
        }

        this.logger.error(
          `SLA sweep failed for tenant ${tenantId}; the next sweep will retry: ${describeFailure(error)}`,
        );
        failedTenants += 1;
      }
    }

    return { due, breached, alerted, skippedTenants, failedTenants };
  }

  private async breachForTenant(
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
          { timeout: SLA_SWEEP_TENANT_TIMEOUT_MS },
        ),
    );

    for (const breach of breaches) {
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

  /** One tenant's whole phase 2, in one transaction: claim, audit, deliver. */
  private async claimAndAlert(
    tx: Prisma.TransactionClient,
    tenantId: string,
    timerIds: readonly string[],
  ): Promise<{ ticketId: string; alerts: InsertedSlaAlert[] }[]> {
    const claimed = await this.claim(tx, timerIds);
    const breaches: { ticketId: string; alerts: InsertedSlaAlert[] }[] = [];

    if (claimed.length === 0) {
      return breaches;
    }

    // Once per transaction, not once per breach: the tenant's supervisors and
    // admins do not change while this transaction runs, and a full 200-timer
    // recovery batch would otherwise issue 200 identical queries inside it.
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
        breaches.push({ ticketId: timer.ticketId, alerts: [] });
        continue;
      }

      breaches.push({
        ticketId: timer.ticketId,
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
   */
  private async claim(
    tx: Prisma.TransactionClient,
    timerIds: readonly string[],
  ): Promise<ClaimedTimerRow[]> {
    const ids = Prisma.join(timerIds.map((id) => Prisma.sql`${id}::uuid`));

    return await tx.$queryRaw<ClaimedTimerRow[]>`
      WITH due AS (
        SELECT id
          FROM sla_timers
         WHERE id IN (${ids}) AND state = 'running' AND due_at <= now()
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
