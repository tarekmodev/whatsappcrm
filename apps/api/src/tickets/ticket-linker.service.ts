import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  TICKET_ACTIVE_STATUSES,
  type InboundMessageTicketTrigger,
  type TicketLinkResult,
  type TicketLinker,
  type TicketStatus,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TICKET_CREATED_EVENT, type TicketCreatedEvent } from '../events/domain-events';
import type { Prisma } from '../generated/prisma/client';
import { MessageDirection } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { uuidV7 } from '../prisma/uuid-v7';
import {
  TicketLinkRaceUnresolvedError,
  TicketTriggerMessageNotVisibleError,
} from './ticket-linking.errors';

/**
 * How many times the create path may lose the race before giving up.
 *
 * Three, from 0003 decision 2. One loss is the ordinary case — a concurrent job
 * won and its ticket is there to attach to on the next attempt. A second means
 * that ticket was resolved in the microseconds in between. A third is not a race
 * any more, it is the constraint and the code disagreeing, and retrying forever
 * would hide that.
 */
const MAX_LINK_ATTEMPTS = 3;

/** What triggered a status change, recorded on the event so TAR-32 can read it. */
const INBOUND_MESSAGE_CAUSE = 'inbound_message';

/** The inbound message, re-read in tenant scope, with the rows it points at. */
interface InboundTarget {
  readonly messageId: string;
  readonly conversationId: string;
  readonly contactId: string;
}

/** The active ticket an attach lands on. */
interface ActiveTicket {
  readonly id: string;
  readonly number: number;
  readonly status: TicketStatus;
  readonly conversationId: string | null;
}

/** One transaction's worth of work: the answer, plus anything to announce after it commits. */
interface LinkAttempt {
  readonly result: TicketLinkResult;
  readonly created: TicketCreatedEvent | null;
}

/** What the create statement hands back when it wins. */
interface AllocatedTicket {
  readonly id: string;
  readonly number: number;
}

/**
 * Puts every inbound message on a ticket, and never on a second one.
 *
 * The implementation of `TicketLinker` from `@whatsappcrm/contracts` — TAR-21's
 * auto-ticketing, specified in `docs/architecture/0003-ticket-auto-linking-contract.md`.
 * TAR-20's inbound processor reaches it through the `TICKET_LINKER` token and a
 * queue job; nothing calls it on production traffic until TAR-77 wires that up.
 *
 * ## What makes it safe to call twice, or twice at once
 *
 * Delivery is at-least-once and ingest is concurrent, so neither idempotence nor
 * the one-active-ticket-per-contact invariant can rest on this class checking
 * first and writing second. Both rest on the database:
 *
 *   * **Create is one statement** — a data-modifying CTE that allocates a ticket
 *     number and inserts the ticket, `ON CONFLICT … DO NOTHING` against
 *     `tickets_one_active_per_contact` (TAR-74). It cannot produce a duplicate
 *     even if every worker in the fleet runs it at the same instant. Zero rows
 *     back means another job won, which is not an error: this re-reads in a new
 *     transaction and attaches to the winner, so the caller never sees a race.
 *   * **Attach writes only to the ticket and its event log.** A ticket is a unit
 *     of work *on* a conversation, not a copy of it — there is no
 *     `messages.ticket_id` and this does not invent one.
 *
 * ## What it refuses to trust
 *
 * The trigger is a queue payload, which is unauthenticated input. `contactId`
 * and `conversationId` are therefore re-derived from the message row read in
 * tenant scope rather than taken from the payload: a forged or stale job reads
 * zero rows under RLS and fails, instead of writing one tenant's ticket against
 * another's contact.
 */
@Injectable()
export class TicketLinkerService implements TicketLinker {
  private readonly logger = new Logger(TicketLinkerService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
  ) {}

  async ensureTicketForMessage(trigger: InboundMessageTicketTrigger): Promise<TicketLinkResult> {
    const target = await this.readInboundTarget(trigger);

    if (target === null) {
      return skipped();
    }

    // Every write below carries the tenant the processor put in scope, not the
    // one the payload claims. Reaching for it only here is deliberate: the read
    // above goes through `TenantPrisma`, so an unscoped call has already failed
    // with `MissingTenantContextError` — the error 0003 specifies for it —
    // rather than with this method's own generic complaint.
    const tenantId = this.tenantContext.requireTenantId();

    for (let attempt = 1; attempt <= MAX_LINK_ATTEMPTS; attempt += 1) {
      const linked = await this.prisma.$tenantTransaction((tx) =>
        this.linkOnce(tx, tenantId, target),
      );

      if (linked === null) {
        // Lost the insert, and the winner was gone by the time it was read back.
        // Rare enough to be worth a line when it happens; loud enough to alert on
        // if it happens three times.
        this.logger.warn(
          `Ticket create for contact ${target.contactId} lost the race and found no ticket to attach to ` +
            `(attempt ${attempt} of ${MAX_LINK_ATTEMPTS})`,
        );
        continue;
      }

      if (linked.created !== null) {
        // After the commit: a ticket pushed to an agent's screen that a rollback
        // then un-wrote is worse than one that arrives a few milliseconds later.
        this.events.emit(TICKET_CREATED_EVENT, linked.created);
      }

      return linked.result;
    }

    throw new TicketLinkRaceUnresolvedError(target.contactId, MAX_LINK_ATTEMPTS);
  }

  /**
   * Re-reads the message the trigger names, and with it the conversation and
   * contact the ticket will actually be written against.
   *
   * Returns `null` for an outbound message — the one state that is correct and
   * will never change on retry, so it is a skip rather than a throw. A message
   * that is not there is the opposite: the realistic cause is a job overtaking
   * the transaction that wrote it, which the next retry fixes.
   *
   * `conversation.contactId` rather than `trigger.contactId`: a conversation
   * belongs to exactly one contact and the row is the authority on which.
   *
   * `trigger.tenantId` appears here only because it is half of the compound key
   * `(tenant_id, id)`. It is not what makes the read safe — RLS is, using the
   * tenant the processor put in scope. A payload naming another tenant therefore
   * matches nothing and fails below, which is the intended outcome for a forged
   * or stale job rather than a case worth its own error.
   */
  private async readInboundTarget(
    trigger: InboundMessageTicketTrigger,
  ): Promise<InboundTarget | null> {
    const message = await this.prisma.message.findUnique({
      where: { tenantId_id: { tenantId: trigger.tenantId, id: trigger.messageId } },
      select: {
        id: true,
        direction: true,
        conversationId: true,
        conversation: { select: { contactId: true } },
      },
    });

    if (message === null) {
      throw new TicketTriggerMessageNotVisibleError(trigger.messageId);
    }

    if (message.direction !== MessageDirection.inbound) {
      return null;
    }

    return {
      messageId: message.id,
      conversationId: message.conversationId,
      contactId: message.conversation.contactId,
    };
  }

  /**
   * One transaction: attach to the contact's active ticket, or create one.
   *
   * Returns `null` when the insert lost the race, which is the caller's cue to
   * try again in a **new** transaction. It has to be a new one — Prisma's
   * interactive transactions expose no savepoint, so a transaction that has seen
   * a conflict has nowhere to roll back to.
   */
  private async linkOnce(
    tx: Prisma.TransactionClient,
    tenantId: string,
    target: InboundTarget,
  ): Promise<LinkAttempt | null> {
    const active = await tx.ticket.findFirst({
      // `tenantId` alongside the RLS predicate so the planner uses
      // `tickets_one_active_per_contact` — the same partial index that enforces
      // the invariant answers the question about it, in one indexed lookup.
      where: { tenantId, contactId: target.contactId, status: { in: TICKET_ACTIVE_STATUSES } },
      select: { id: true, number: true, status: true, conversationId: true },
    });

    return active === null
      ? await this.create(tx, tenantId, target)
      : await this.attach(tx, tenantId, active, target);
  }

  /**
   * The contact already has a live ticket, so this message belongs to it.
   *
   * Three cases, and two of them write nothing to the ticket itself:
   *
   *   * already `open` — no state change, no event;
   *   * `pending` — the customer has replied to a ticket that was waiting on
   *     them, so it reopens and records why. `previousStatus` carries that out to
   *     the caller because it is TAR-26's cue to resume a paused SLA timer, and
   *     making the caller infer it would mean re-reading the row;
   *   * the message arrived on a different conversation — only reachable for a
   *     tenant running more than one WhatsApp number. The link is recorded and
   *     `conversation_id` is deliberately left pointing at the conversation the
   *     ticket was opened from (0003, open question 2).
   */
  private async attach(
    tx: Prisma.TransactionClient,
    tenantId: string,
    active: ActiveTicket,
    target: InboundTarget,
  ): Promise<LinkAttempt> {
    if (active.status === 'pending') {
      await this.reopen(tx, tenantId, active);
    }

    if (active.conversationId !== target.conversationId) {
      await tx.ticketEvent.create({
        data: {
          tenantId,
          ticketId: active.id,
          type: 'conversation_linked',
          data: { conversationId: target.conversationId, messageId: target.messageId },
        },
      });
    }

    return {
      result: {
        outcome: 'attached',
        ticketId: active.id,
        ticketNumber: active.number,
        previousStatus: active.status,
        reason: null,
      },
      created: null,
    };
  }

  /**
   * `pending` → `open`, with the guard in the `WHERE` clause so the check and
   * the write are one statement rather than a read-modify-write two workers can
   * interleave. The event is appended only if this transaction is the one that
   * moved it, so the log never claims a transition that did not happen.
   */
  private async reopen(
    tx: Prisma.TransactionClient,
    tenantId: string,
    active: ActiveTicket,
  ): Promise<void> {
    const { count } = await tx.ticket.updateMany({
      where: { tenantId, id: active.id, status: 'pending' },
      data: { status: 'open' },
    });

    if (count === 0) {
      return;
    }

    await tx.ticketEvent.create({
      data: {
        tenantId,
        ticketId: active.id,
        type: 'status_changed',
        data: { from: 'pending', to: 'open', cause: INBOUND_MESSAGE_CAUSE },
      },
    });
  }

  /**
   * The create path: allocate a number and insert the ticket in one statement
   * that cannot produce a duplicate. Returns `null` when another job won.
   *
   * Raw SQL because the Prisma client can express neither half of it — a
   * data-modifying CTE, and `ON CONFLICT … WHERE` naming a partial index. This
   * is verbatim the statement TAR-74 proved against a real database in
   * `src/prisma/ticket-active-uniqueness.int-spec.ts`, with `updated_at` added to
   * the counter's `DO UPDATE` branch: Postgres does not refresh a column default
   * on update, so without it the column would record when a tenant's counter was
   * created rather than when it was last used.
   *
   * Every value is a bound parameter. `tenantId` is supplied explicitly because
   * TAR-49's extension does not inject it; RLS's `WITH CHECK` rejects the row if
   * it is ever wrong, which is the backstop rather than the mechanism.
   *
   * The id is generated here because `@default(uuid(7))` is a client-side
   * default and this statement does not go through the client.
   *
   * Numbers are unique and monotonic but not gapless: the CTE still increments
   * when the outer insert loses, and nothing depends on density.
   */
  private async create(
    tx: Prisma.TransactionClient,
    tenantId: string,
    target: InboundTarget,
  ): Promise<LinkAttempt | null> {
    const ticketId = uuidV7();

    const [ticket] = await tx.$queryRaw<AllocatedTicket[]>`
      WITH allocated AS (
        INSERT INTO ticket_counters (tenant_id, next_number) VALUES (${tenantId}::uuid, 2)
        ON CONFLICT (tenant_id) DO UPDATE
          SET next_number = ticket_counters.next_number + 1, updated_at = now()
        RETURNING next_number - 1 AS number
      )
      INSERT INTO tickets (id, tenant_id, number, status, conversation_id, contact_id, created_at, updated_at)
      SELECT ${ticketId}::uuid, ${tenantId}::uuid, allocated.number, 'open',
             ${target.conversationId}::uuid, ${target.contactId}::uuid, now(), now()
      FROM allocated
      ON CONFLICT (tenant_id, contact_id) WHERE status IN ('open', 'pending') DO NOTHING
      RETURNING id, number
    `;

    if (ticket === undefined) {
      return null;
    }

    await tx.ticketEvent.create({
      data: {
        tenantId,
        ticketId: ticket.id,
        type: 'created',
        data: { conversationId: target.conversationId, cause: INBOUND_MESSAGE_CAUSE },
      },
    });

    return {
      result: {
        outcome: 'created',
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        previousStatus: null,
        reason: null,
      },
      created: {
        tenantId,
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        contactId: target.contactId,
        conversationId: target.conversationId,
      },
    };
  }
}

/** The one outcome that writes nothing: the message was ours, not the customer's. */
function skipped(): TicketLinkResult {
  return {
    outcome: 'skipped',
    ticketId: null,
    ticketNumber: null,
    previousStatus: null,
    reason: 'not_inbound',
  };
}
