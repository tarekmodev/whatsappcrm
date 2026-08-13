import type { EventEmitter2 } from '@nestjs/event-emitter';
import {
  InboundMessageTicketTriggerSchema,
  TicketLinkResultSchema,
  type InboundMessageTicketTrigger,
  type TicketLinkResult,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TICKET_CREATED_EVENT } from '../events/domain-events';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { TicketLinkerService } from './ticket-linker.service';
import {
  TicketLinkRaceUnresolvedError,
  TicketTriggerMessageNotVisibleError,
} from './ticket-linking.errors';

/**
 * TAR-75 against TAR-73's contract, with no pipeline and no database.
 *
 * The trigger is a literal parsed through `InboundMessageTicketTriggerSchema`,
 * which is the whole point of 0003 fixing the shape before TAR-20 exists: if the
 * fixture stops matching the published schema these tests stop compiling, and if
 * TAR-20 emits something else its own tests fail rather than this one silently
 * passing.
 *
 * What this file can and cannot prove is worth being explicit about. It proves
 * the branching, what is written on each path, and that a lost race is resolved
 * rather than surfaced. It cannot prove the invariant — two overlapping
 * transactions against a real partial unique index is not something a mocked
 * client can observe, and asserting it here would only assert the code we wrote.
 * `ticket-linker.int-spec.ts` runs the same service against a real PostgreSQL for
 * that, and `src/prisma/ticket-active-uniqueness.int-spec.ts` covers the index
 * underneath it.
 */

const TENANT = '01923f4a-0000-7000-8000-0000000000a0';
/** A second tenant, only ever used as a value a payload might lie with. */
const OTHER_TENANT = '01923f4a-0000-7000-8000-0000000000b0';
const CONTACT = '01923f4a-0000-7000-8000-0000000000a1';
const CONVERSATION = '01923f4a-0000-7000-8000-0000000000a2';
/** The tenant's second WhatsApp number, so the same contact has two threads. */
const OTHER_CONVERSATION = '01923f4a-0000-7000-8000-0000000000a3';
const MESSAGE = '01923f4a-0000-7000-8000-0000000000a4';
const TICKET = '01923f4a-0000-7000-8000-0000000000a5';
/** The ticket a concurrent job created while this one was inserting. */
const WINNING_TICKET = '01923f4a-0000-7000-8000-0000000000a6';

const TRIGGER: InboundMessageTicketTrigger = InboundMessageTicketTriggerSchema.parse({
  tenantId: TENANT,
  contactId: CONTACT,
  conversationId: CONVERSATION,
  messageId: MESSAGE,
  receivedAt: '2026-08-11T09:41:00.000Z',
});

interface MessageRow {
  id: string;
  direction: 'inbound' | 'outbound';
  conversationId: string;
  conversation: { contactId: string };
}

const INBOUND_MESSAGE: MessageRow = {
  id: MESSAGE,
  direction: 'inbound',
  conversationId: CONVERSATION,
  conversation: { contactId: CONTACT },
};

interface ActiveTicketRow {
  id: string;
  number: number;
  status: 'open' | 'pending';
  conversationId: string | null;
}

interface Harness {
  readonly service: TicketLinkerService;
  readonly findMessage: jest.Mock;
  readonly findActiveTicket: jest.Mock;
  readonly updateTicket: jest.Mock;
  readonly createTicketEvent: jest.Mock;
  readonly insertTicket: jest.Mock;
  readonly transaction: jest.Mock;
  readonly emit: jest.Mock;
  /** Runs `ensureTicketForMessage` inside a tenant scope, the way a worker would. */
  link(trigger?: InboundMessageTicketTrigger, tenantId?: string): Promise<TicketLinkResult>;
}

function build(message: MessageRow | null = INBOUND_MESSAGE): Harness {
  const findMessage = jest.fn().mockResolvedValue(message);
  const findActiveTicket = jest.fn().mockResolvedValue(null);
  const updateTicket = jest.fn().mockResolvedValue({ count: 1 });
  const createTicketEvent = jest.fn().mockResolvedValue(undefined);
  const insertTicket = jest.fn().mockResolvedValue([]);
  const emit = jest.fn();

  const tx = {
    ticket: { findFirst: findActiveTicket, updateMany: updateTicket },
    ticketEvent: { create: createTicketEvent },
    $queryRaw: insertTicket,
  };

  const transaction = jest.fn((work: (client: typeof tx) => Promise<unknown>) => work(tx));
  const prisma = {
    message: { findUnique: findMessage },
    $tenantTransaction: transaction,
  } as unknown as TenantPrisma;

  const tenantContext = new TenantContextService();
  const service = new TicketLinkerService(prisma, tenantContext, {
    emit,
  } as unknown as EventEmitter2);

  return {
    service,
    findMessage,
    findActiveTicket,
    updateTicket,
    createTicketEvent,
    insertTicket,
    transaction,
    emit,
    link: (trigger = TRIGGER, tenantId = TENANT) =>
      tenantContext.run({ requestId: 'tar75-spec', tenantId, userId: null }, async () =>
        // Parsed on the way out as well as on the way in: a result that does not
        // satisfy `TicketLinkResultSchema` is a contract break, not a detail.
        TicketLinkResultSchema.parse(await service.ensureTicketForMessage(trigger)),
      ),
  };
}

/** The winning create statement's return shape. */
function allocated(id = TICKET, number = 1): { id: string; number: number }[] {
  return [{ id, number }];
}

function activeTicket(overrides: Partial<ActiveTicketRow> = {}): ActiveTicketRow {
  return { id: TICKET, number: 7, status: 'open', conversationId: CONVERSATION, ...overrides };
}

/** The `data` an appended ticket event carried, by type. */
function eventsOfType(createTicketEvent: jest.Mock, type: string): Record<string, unknown>[] {
  return createTicketEvent.mock.calls
    .map(([argument]) => (argument as { data: Record<string, unknown> }).data)
    .filter((data) => data.type === type);
}

describe('TicketLinkerService', () => {
  describe('no active ticket for the contact', () => {
    it('creates one, open and linked to the conversation', async () => {
      const harness = build();
      harness.insertTicket.mockResolvedValue(allocated(TICKET, 12));

      await expect(harness.link()).resolves.toEqual({
        outcome: 'created',
        ticketId: TICKET,
        ticketNumber: 12,
        previousStatus: null,
        reason: null,
      });
    });

    /**
     * The statement is the mechanism, so its shape is asserted rather than just
     * its effect: allocation and insert in one statement, and a conflict target
     * that names `tickets_one_active_per_contact`'s predicate. A create path that
     * quietly became a check-then-insert would still pass every other test here.
     */
    it('allocates the number and inserts the ticket in one conflict-tolerant statement', async () => {
      const harness = build();
      harness.insertTicket.mockResolvedValue(allocated());

      await harness.link();

      const [fragments, ...values] = harness.insertTicket.mock.calls[0] as [string[], ...unknown[]];
      const sql = fragments.join('?');

      expect(sql).toContain('INSERT INTO ticket_counters');
      expect(sql).toContain('ON CONFLICT (tenant_id, contact_id)');
      expect(sql).toContain("WHERE status IN ('open', 'pending') DO NOTHING");
      // Bound parameters, never interpolation: the ids reach Postgres as values.
      expect(values).toEqual([TENANT, expect.any(String), TENANT, CONVERSATION, CONTACT]);
    });

    it('refreshes the counter row when it bumps it', async () => {
      // Postgres does not re-apply a column default on update, so without this
      // `ticket_counters.updated_at` would record when a tenant's counter was
      // created rather than when it last handed out a number.
      const harness = build();
      harness.insertTicket.mockResolvedValue(allocated());

      await harness.link();

      const [fragments] = harness.insertTicket.mock.calls[0] as [string[]];

      expect(fragments.join('?')).toContain('updated_at = now()');
    });

    it('records the created event and announces it after the transaction', async () => {
      const harness = build();
      harness.insertTicket.mockResolvedValue(allocated(TICKET, 12));

      await harness.link();

      expect(eventsOfType(harness.createTicketEvent, 'created')).toHaveLength(1);
      expect(harness.emit).toHaveBeenCalledWith(TICKET_CREATED_EVENT, {
        tenantId: TENANT,
        ticketId: TICKET,
        ticketNumber: 12,
        contactId: CONTACT,
        conversationId: CONVERSATION,
      });
      // Emitted by `ensureTicketForMessage`, outside the transaction callback —
      // pushing a ticket a rollback then un-wrote is the failure this ordering
      // exists to prevent.
      expect(harness.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('an active ticket already exists', () => {
    it('attaches to it instead of creating a second one', async () => {
      const harness = build();
      harness.findActiveTicket.mockResolvedValue(activeTicket({ number: 7 }));

      await expect(harness.link()).resolves.toEqual({
        outcome: 'attached',
        ticketId: TICKET,
        ticketNumber: 7,
        previousStatus: 'open',
        reason: null,
      });
      expect(harness.insertTicket).not.toHaveBeenCalled();
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('leaves an already-open ticket completely alone', async () => {
      const harness = build();
      harness.findActiveTicket.mockResolvedValue(activeTicket());

      await harness.link();

      expect(harness.updateTicket).not.toHaveBeenCalled();
      expect(harness.createTicketEvent).not.toHaveBeenCalled();
    });

    /**
     * The amendment TAR-73 made to TAR-74, seen from the application side: a
     * `pending` ticket is the contact's live thread, so their reply reopens it
     * rather than opening a second one beside it.
     */
    it('counts pending as active when it looks for one', async () => {
      const harness = build();
      harness.findActiveTicket.mockResolvedValue(activeTicket({ status: 'pending' }));

      await harness.link();

      const [query] = harness.findActiveTicket.mock.calls[0] as [
        { where: { tenantId: string; contactId: string; status: { in: string[] } } },
      ];

      expect(query.where.status.in).toEqual(expect.arrayContaining(['open', 'pending']));
      expect(query.where.status.in).not.toEqual(expect.arrayContaining(['resolved', 'closed']));
      expect(query.where).toMatchObject({ tenantId: TENANT, contactId: CONTACT });
    });

    it('reopens a pending ticket and reports the status the caller has to act on', async () => {
      const harness = build();
      harness.findActiveTicket.mockResolvedValue(activeTicket({ status: 'pending' }));

      // `previousStatus: 'pending'` is TAR-26's cue to resume a paused SLA timer.
      // It is on the result so the caller does not have to re-read the row to
      // learn something this call already knew.
      await expect(harness.link()).resolves.toMatchObject({
        outcome: 'attached',
        previousStatus: 'pending',
      });

      expect(harness.updateTicket).toHaveBeenCalledWith({
        // The guard is in the `WHERE` clause so the check and the write are one
        // statement rather than a read-modify-write two workers can interleave.
        where: { tenantId: TENANT, id: TICKET, status: 'pending' },
        data: { status: 'open' },
      });
      expect(eventsOfType(harness.createTicketEvent, 'status_changed')).toEqual([
        expect.objectContaining({
          data: { from: 'pending', to: 'open', cause: 'inbound_message' },
        }),
      ]);
    });

    it('records the link when the message arrived on another conversation', async () => {
      // Only reachable for a tenant running more than one WhatsApp number: the
      // ticket invariant is per contact, conversations are per contact per
      // number. Recorded rather than acted on, so the real frequency is
      // measurable before anyone changes the invariant (0003, open question 2).
      const harness = build();
      harness.findActiveTicket.mockResolvedValue(
        activeTicket({ conversationId: OTHER_CONVERSATION }),
      );

      await harness.link();

      expect(eventsOfType(harness.createTicketEvent, 'conversation_linked')).toEqual([
        expect.objectContaining({
          data: { conversationId: CONVERSATION, messageId: MESSAGE },
        }),
      ]);
      // The ticket keeps pointing at the conversation it was opened from.
      expect(harness.updateTicket).not.toHaveBeenCalled();
    });

    it('records nothing when the message arrived on the ticket’s own conversation', async () => {
      const harness = build();
      harness.findActiveTicket.mockResolvedValue(activeTicket());

      await harness.link();

      expect(eventsOfType(harness.createTicketEvent, 'conversation_linked')).toHaveLength(0);
    });
  });

  /**
   * The second writer TAR-25 put on these rows: `PATCH /tickets/{id}`. A ticket
   * read as `pending` can be `resolved` a millisecond later, and the reopen's
   * `WHERE status = 'pending'` then matches nothing.
   *
   * The old behaviour was to carry on and report `attached` against it, which
   * was two failures at once — the customer's reply recorded on a finished
   * ticket, leaving the contact with **no** active one until they wrote again,
   * and a `previousStatus: 'pending'` handed to TAR-26 as a resume cue for a
   * transition that never happened. So a lost reopen now abandons the attempt
   * and the loop reads the contact's ticket again.
   */
  describe('losing the reopen race to an agent', () => {
    it('opens a new ticket when the agent resolved it', async () => {
      const harness = build();
      // First attempt: pending when read, gone from `pending` by the time the
      // compare-and-set lands. Second attempt: the agent resolved it, so the
      // contact has no active ticket and this reply deserves a fresh one.
      harness.findActiveTicket
        .mockResolvedValueOnce(activeTicket({ status: 'pending' }))
        .mockResolvedValueOnce(null);
      harness.updateTicket.mockResolvedValueOnce({ count: 0 });
      harness.insertTicket.mockResolvedValue(allocated(WINNING_TICKET, 8));

      await expect(harness.link()).resolves.toEqual({
        outcome: 'created',
        ticketId: WINNING_TICKET,
        ticketNumber: 8,
        previousStatus: null,
        reason: null,
      });

      // A new transaction for the retry, for the same reason the create race
      // needs one: Prisma exposes no savepoint.
      expect(harness.transaction).toHaveBeenCalledTimes(2);
      // And nothing claims a transition that did not happen.
      expect(eventsOfType(harness.createTicketEvent, 'status_changed')).toHaveLength(0);
    });

    it('attaches without a reopen when the agent had only moved it to open', async () => {
      const harness = build();
      harness.findActiveTicket
        .mockResolvedValueOnce(activeTicket({ status: 'pending' }))
        .mockResolvedValueOnce(activeTicket({ status: 'open' }));
      harness.updateTicket.mockResolvedValueOnce({ count: 0 });

      // `previousStatus: 'open'` — the honest answer, and the one that does not
      // tell TAR-26 to resume a timer this reply did not unpause.
      await expect(harness.link()).resolves.toMatchObject({
        outcome: 'attached',
        ticketId: TICKET,
        previousStatus: 'open',
      });
      expect(eventsOfType(harness.createTicketEvent, 'status_changed')).toHaveLength(0);
    });

    it('writes no conversation_linked against the ticket it abandons', async () => {
      // Ordering, not decoration: the losing transaction still commits, so a
      // `conversation_linked` written before the reopen was checked would land
      // on a ticket this attempt is about to walk away from — and then be
      // written again against the ticket the retry lands on.
      const harness = build();
      harness.findActiveTicket
        .mockResolvedValueOnce(
          activeTicket({ status: 'pending', conversationId: OTHER_CONVERSATION }),
        )
        .mockResolvedValueOnce(null);
      harness.updateTicket.mockResolvedValueOnce({ count: 0 });
      harness.insertTicket.mockResolvedValue(allocated(WINNING_TICKET, 8));

      await harness.link();

      expect(eventsOfType(harness.createTicketEvent, 'conversation_linked')).toHaveLength(0);
    });

    it('gives up loudly after three attempts rather than retrying forever', async () => {
      // An agent would have to move the same ticket out of `pending` three times
      // in a row for this to fire. If it ever does, something is flapping the
      // status and that is worth an alert rather than an unbounded loop.
      const harness = build();
      harness.findActiveTicket.mockResolvedValue(activeTicket({ status: 'pending' }));
      harness.updateTicket.mockResolvedValue({ count: 0 });

      await expect(harness.link()).rejects.toThrow(TicketLinkRaceUnresolvedError);
      expect(harness.transaction).toHaveBeenCalledTimes(3);
    });
  });

  describe('losing the create race', () => {
    it('attaches to the winner rather than surfacing a conflict', async () => {
      const harness = build();
      // First attempt: no active ticket, and the insert returns nothing because a
      // concurrent job got there first. Second attempt: the winner is visible.
      harness.findActiveTicket
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(activeTicket({ id: WINNING_TICKET, number: 3 }));
      harness.insertTicket.mockResolvedValue([]);

      await expect(harness.link()).resolves.toEqual({
        outcome: 'attached',
        ticketId: WINNING_TICKET,
        ticketNumber: 3,
        previousStatus: 'open',
        reason: null,
      });

      // A new transaction for the retry, not a re-read inside the old one:
      // Prisma exposes no savepoint, so a transaction that has seen a conflict
      // has nowhere to roll back to.
      expect(harness.transaction).toHaveBeenCalledTimes(2);
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('gives up loudly after three attempts rather than retrying forever', async () => {
      // Should be unreachable: losing three times means the winner was resolved
      // between every attempt. If it ever fires, the constraint and the code
      // disagree about what counts as active, which is a thing to alert on.
      const harness = build();
      harness.insertTicket.mockResolvedValue([]);

      await expect(harness.link()).rejects.toThrow(TicketLinkRaceUnresolvedError);
      expect(harness.transaction).toHaveBeenCalledTimes(3);
    });
  });

  describe('what it will not do', () => {
    it('skips an outbound message without opening a transaction', async () => {
      const harness = build({ ...INBOUND_MESSAGE, direction: 'outbound' });

      await expect(harness.link()).resolves.toEqual({
        outcome: 'skipped',
        ticketId: null,
        ticketNumber: null,
        previousStatus: null,
        reason: 'not_inbound',
      });
      expect(harness.transaction).not.toHaveBeenCalled();
    });

    it('throws when the message is not visible, so the job retries', async () => {
      // Commit-visibility timing, a sweeper replay ahead of a rollback — or a
      // forged payload naming another tenant's message, which RLS turns into
      // exactly this. All three are retried, and a message that never becomes a
      // ticket ends up in the monitored failed set rather than being skipped.
      const harness = build(null);

      await expect(harness.link()).rejects.toThrow(TicketTriggerMessageNotVisibleError);
      expect(harness.transaction).not.toHaveBeenCalled();
    });
  });

  describe('what it trusts', () => {
    it('takes the contact and conversation from the message, not from the payload', async () => {
      // The payload is unauthenticated input. A job naming the wrong contact
      // must not write a ticket against it.
      const harness = build();
      harness.insertTicket.mockResolvedValue(allocated());

      await harness.link(
        InboundMessageTicketTriggerSchema.parse({
          ...TRIGGER,
          contactId: '01923f4a-0000-7000-8000-0000000000c1',
          conversationId: '01923f4a-0000-7000-8000-0000000000c2',
        }),
      );

      // `[counterTenant, ticketId, ticketTenant, conversationId, contactId]`,
      // in the order the statement interpolates them.
      const [, ...values] = harness.insertTicket.mock.calls[0] as [string[], ...string[]];

      expect(values.slice(3)).toEqual([CONVERSATION, CONTACT]);
    });

    it('writes against the tenant in scope, not the one the payload claims', async () => {
      // TAR-49's extension does not inject `tenant_id`; every write supplies it,
      // and it comes from the scope the processor opened. RLS's `WITH CHECK` is
      // the backstop under that, not the mechanism.
      const harness = build();
      harness.findActiveTicket.mockResolvedValue(activeTicket({ status: 'pending' }));

      await harness.link(
        InboundMessageTicketTriggerSchema.parse({ ...TRIGGER, tenantId: OTHER_TENANT }),
        TENANT,
      );

      expect(harness.updateTicket).toHaveBeenCalledWith({
        where: { tenantId: TENANT, id: TICKET, status: 'pending' },
        data: { status: 'open' },
      });
      expect(eventsOfType(harness.createTicketEvent, 'status_changed')).toEqual([
        expect.objectContaining({ tenantId: TENANT }),
      ]);
    });
  });
});
