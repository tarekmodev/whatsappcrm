import { Inject, Injectable } from '@nestjs/common';
import type { SlaEvaluateTicketTrigger, SlaTargetKind } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import { MessageDirection, type SlaTimerState } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { SLA_TIMER_KINDS } from './sla.constants';
import { SlaTicketNotVisibleError } from './sla.errors';
import { SlaPolicyService, type ResolvedSlaPolicy } from './sla-policy.service';
import { slaTimerTargetFor, type SlaTimerTarget } from './sla-timer-target';

/**
 * The only writer of `sla_timers` outside the breach sweep.
 *
 * One public method, `evaluate`, handling all four ticket-level triggers 0006
 * names — a ticket created, an agent replying, a status changing, a customer
 * replying to a paused ticket. They enqueue **the same job**, and this handler
 * re-derives the whole timer state for the ticket from the row rather than
 * trusting the trigger's `reason`.
 *
 * ## Why a reconciler and not four handlers
 *
 * Delivery is at-least-once and the four producers are independent, so ordering
 * between them is not something this module can assume. A set of specialised
 * handlers would each have to be correct about arriving after the other three; a
 * reconciler converges on the same state whichever order it is called in, and a
 * duplicate delivery is a no-op by construction. That is the property that makes
 * losing, duplicating or delaying a job harmless here.
 *
 * ## The deadline is anchored to the ticket, not to the job
 *
 * A timer is created with `started_at = ticket.created_at` and
 * `due_at = ticket.created_at + window`. A job that runs late therefore does not
 * hand the ticket a free extension — which it would if the deadline were
 * measured from `now()`, and which would be silently invisible: a Redis outage
 * would look like everybody suddenly meeting their SLA.
 *
 * ## Isolation
 *
 * Every statement goes through `TenantPrisma` inside one `$tenantTransaction`,
 * under the scope `QueueService` opened from the job's own `tenantId`. A payload
 * naming another tenant's ticket reads zero rows under RLS and fails as
 * `SlaTicketNotVisibleError` rather than writing anything.
 */

const EVALUATION_PROJECTION = {
  id: true,
  status: true,
  priority: true,
  conversationId: true,
  firstRespondedAt: true,
  resolvedAt: true,
  createdAt: true,
  slaTimers: { select: { id: true, kind: true, state: true, policyId: true } },
} as const satisfies Prisma.TicketSelect;

type EvaluationTicket = Prisma.TicketGetPayload<{ select: typeof EVALUATION_PROJECTION }>;

/** What one evaluation did, for the runner's log line. */
export interface SlaEvaluationSummary {
  readonly ticketId: string;
  readonly created: number;
  readonly transitioned: number;
  readonly firstResponseStamped: boolean;
}

/** The states a reconciler may still move a timer out of. The rest are terminal. */
const MUTABLE_STATES: readonly SlaTimerState[] = ['running', 'paused'];

const MILLISECONDS_PER_MINUTE = 60_000;

@Injectable()
export class SlaTimerService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly policies: SlaPolicyService,
  ) {}

  async evaluate(trigger: SlaEvaluateTicketTrigger): Promise<SlaEvaluationSummary> {
    return await this.prisma.$tenantTransaction(async (tx) => {
      const ticket = await tx.ticket.findUnique({
        where: { id: trigger.ticketId },
        select: EVALUATION_PROJECTION,
      });

      if (ticket === null) {
        throw new SlaTicketNotVisibleError(trigger.ticketId);
      }

      const firstRespondedAt = await this.stampFirstResponse(tx, trigger.tenantId, ticket);
      const created = await this.createMissingTimers(tx, trigger.tenantId, ticket);
      const transitioned = await this.reconcile(tx, ticket, firstRespondedAt, created > 0);

      return {
        ticketId: ticket.id,
        created,
        transitioned,
        firstResponseStamped: ticket.firstRespondedAt === null && firstRespondedAt !== null,
      };
    });
  }

  /**
   * Writes `tickets.first_response_at` the first time a person has replied on
   * the ticket's conversation, and appends the `first_response` event that
   * TAR-32's history and TAR-30's cycle-time reporting read.
   *
   * **Derived from the messages, not from the trigger.** The `agent_replied`
   * trigger is a hint that it is worth looking; what decides is an outbound
   * message with a non-null `sender_user_id` sent at or after the ticket was
   * opened. That non-null sender is 0006's answer to "does a chatbot reply count
   * as a first response" — no, because the bot writes no `sender_user_id`, and
   * making it a property of the row rather than of the calling code means TAR-28
   * inherits the decision instead of re-making it by accident.
   *
   * The guard is in the `WHERE` clause, so the check and the write are one
   * statement two workers cannot interleave, and the event is appended only by
   * the transaction that actually moved the column.
   *
   * **Known gap (0006, risk 3).** Only the ticket's own conversation is
   * searched. A tenant running two WhatsApp numbers can have the same contact on
   * a second conversation, and a reply sent there would not stop this timer.
   * Recorded rather than built: it needs a tenant with two WABAs and the same
   * contact on both, and the wider query reads `conversation_linked` ticket
   * events.
   */
  private async stampFirstResponse(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ticket: EvaluationTicket,
  ): Promise<Date | null> {
    if (ticket.firstRespondedAt !== null) {
      return ticket.firstRespondedAt;
    }

    if (ticket.conversationId === null) {
      return null;
    }

    const reply = await tx.message.findFirst({
      where: {
        conversationId: ticket.conversationId,
        direction: MessageDirection.outbound,
        senderUserId: { not: null },
        sentAt: { gte: ticket.createdAt },
      },
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      select: { sentAt: true },
    });

    if (reply === null) {
      return null;
    }

    const { count } = await tx.ticket.updateMany({
      where: { id: ticket.id, firstRespondedAt: null },
      data: { firstRespondedAt: reply.sentAt },
    });

    if (count > 0) {
      await tx.ticketEvent.create({
        data: {
          tenantId,
          ticketId: ticket.id,
          type: 'first_response',
          // No actor: the timer observed the reply, it did not make it. The
          // message row is where "who answered" lives.
          data: { respondedAt: reply.sentAt.toISOString() },
        },
        select: { id: true },
      });
    }

    return reply.sentAt;
  }

  /**
   * Creates the timers the resolved policy defines and the ticket does not have
   * yet. Returns how many rows were written.
   *
   * `skipDuplicates` on the `(tenant_id, ticket_id, kind)` unique index is what
   * makes two concurrent evaluations of the same ticket produce one timer per
   * kind rather than a unique violation — the same "let the constraint decide"
   * shape `TicketLinkerService` uses for the ticket itself.
   *
   * A ticket that already has timers keeps the **policy it started under**, even
   * if resolution would pick a different one now. Re-resolving would move a
   * running deadline the moment a supervisor edited a priority, and 0006 is
   * explicit that a policy edit changes future tickets and never past deadlines.
   */
  private async createMissingTimers(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ticket: EvaluationTicket,
  ): Promise<number> {
    const startedPolicyId = ticket.slaTimers[0]?.policyId ?? null;
    const policy =
      startedPolicyId === null
        ? await this.policies.resolveForTicket(tx, tenantId, ticket.priority)
        : await this.policies.findWindows(tx, startedPolicyId);

    if (policy === null) {
      // No active policy, or a policy that has since been deleted. The tenant has
      // turned SLA off, or never had it on: no timers, and the ticket reports
      // `not_applicable`.
      return 0;
    }

    const held = new Set(ticket.slaTimers.map((timer) => timer.kind));
    const rows = SLA_TIMER_KINDS.filter((kind) => !held.has(kind))
      .map((kind) => ({ kind, minutes: windowFor(policy, kind) }))
      .filter(
        (target): target is { kind: SlaTargetKind; minutes: number } => target.minutes !== null,
      )
      .map(({ kind, minutes }) => ({
        tenantId,
        ticketId: ticket.id,
        policyId: policy.id,
        kind,
        startedAt: ticket.createdAt,
        dueAt: new Date(ticket.createdAt.getTime() + minutes * MILLISECONDS_PER_MINUTE),
      }));

    if (rows.length === 0) {
      return 0;
    }

    const { count } = await tx.slaTimer.createMany({ data: rows, skipDuplicates: true });

    return count;
  }

  /**
   * Moves every mutable timer on the ticket to the state the ticket implies.
   *
   * Re-reads the timers when something was created, so a freshly created timer on
   * a `pending` ticket is paused in the same transaction that created it rather
   * than running until the next trigger.
   */
  private async reconcile(
    tx: Prisma.TransactionClient,
    ticket: EvaluationTicket,
    firstRespondedAt: Date | null,
    reread: boolean,
  ): Promise<number> {
    const timers = reread
      ? await tx.slaTimer.findMany({
          where: { ticketId: ticket.id },
          select: { id: true, kind: true, state: true, policyId: true },
        })
      : ticket.slaTimers;

    let transitioned = 0;

    for (const timer of timers) {
      if (!MUTABLE_STATES.includes(timer.state)) {
        continue;
      }

      const target = slaTimerTargetFor({
        kind: timer.kind,
        status: ticket.status,
        firstRespondedAt,
        resolvedAt: ticket.resolvedAt,
      });

      transitioned += await this.applyTransition(tx, timer.id, timer.state, target);
    }

    return transitioned;
  }

  /**
   * One guarded state change. Returns 1 when this transaction is the one that
   * moved the row, 0 otherwise.
   *
   * Raw SQL for two reasons, both load-bearing:
   *
   *   * **Every timestamp is Postgres `now()`, never a node clock.** The same
   *     rule the schema states for `users.locked_until`: skew between API
   *     instances must not be able to shorten or extend a deadline.
   *   * **Resume is arithmetic on the row.** `due_at = due_at + (now() -
   *     paused_at)` cannot be expressed through the Prisma client, and computing
   *     it in TypeScript would mean reading, adding and writing — a window two
   *     workers can interleave into a deadline pushed forward twice.
   *
   * The `state` predicate in every `WHERE` is what makes each of these safe to
   * run concurrently: two evaluations racing on the same timer produce one
   * transition, and the loser updates nothing.
   */
  private async applyTransition(
    tx: Prisma.TransactionClient,
    timerId: string,
    from: SlaTimerState,
    target: SlaTimerTarget,
  ): Promise<number> {
    if (from === target) {
      return 0;
    }

    if (target === 'paused') {
      return await tx.$executeRaw`
        UPDATE sla_timers
           SET state = 'paused', paused_at = now()
         WHERE id = ${timerId}::uuid AND state = 'running'
      `;
    }

    if (target === 'running') {
      return await tx.$executeRaw`
        UPDATE sla_timers
           SET state     = 'running',
               due_at    = due_at + (now() - paused_at),
               paused_ms = paused_ms + (extract(epoch from now() - paused_at) * 1000)::int,
               paused_at = NULL
         WHERE id = ${timerId}::uuid AND state = 'paused'
      `;
    }

    // `met` or `cancelled`: the clock stops where it is. A timer stopped while
    // paused folds the open pause into `paused_ms` so the accounting stays
    // complete — nothing reads it during the sweep, but TAR-30 reports working
    // time from it, and an unclosed pause would understate it.
    return await tx.$executeRaw`
      UPDATE sla_timers
         SET state      = ${target}::sla_timer_state,
             stopped_at = now(),
             paused_ms  = paused_ms + CASE
                            WHEN paused_at IS NULL THEN 0
                            ELSE (extract(epoch from now() - paused_at) * 1000)::int
                          END,
             paused_at  = NULL
       WHERE id = ${timerId}::uuid AND state IN ('running', 'paused')
    `;
  }
}

function windowFor(policy: ResolvedSlaPolicy, kind: SlaTargetKind): number | null {
  return kind === 'first_response' ? policy.firstResponseMinutes : policy.resolutionMinutes;
}
