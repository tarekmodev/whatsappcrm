import { EventEmitter2 } from '@nestjs/event-emitter';
import type { InboundMessageTicketTrigger, TicketLinkResult } from '@whatsappcrm/contracts';
import { InboundMessageTicketTriggerSchema } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TICKET_CREATED_EVENT, type TicketCreatedEvent } from '../events/domain-events';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { TicketLinkerService } from './ticket-linker.service';

/**
 * TAR-75 against a real PostgreSQL, as `whatsappcrm_app`.
 *
 * `ticket-linker.service.spec.ts` covers the branching with a mocked client.
 * This file covers the one property a mock cannot observe and the whole design
 * rests on: **two concurrent calls for the same contact produce exactly one
 * ticket**, because `tickets_one_active_per_contact` (TAR-74) says so rather
 * than because the service checked first.
 *
 * It also proves the create statement composes with the rest of the service —
 * the raw `INSERT … ON CONFLICT` runs inside `$tenantTransaction`, under RLS,
 * with an id the Prisma client did not generate. TAR-74 proved the statement in
 * isolation; this proves the path that ships it.
 *
 * ⚠️ Writes and commits. Two fixture tenants carrying fixed ids and a
 * `tar75-fixture` marker, deleted before the run as well as after it, so an
 * interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '75777777-7777-7777-8777-777777777701';
const TENANT_B = '75777777-7777-7777-8777-777777777702';

const WABA_A = '75777777-7777-7777-8777-7777777777a0';
const ACCOUNT_A = '75777777-7777-7777-8777-7777777777a1';
const CONTACT_A = '75777777-7777-7777-8777-7777777777a2';
const CONVERSATION_A = '75777777-7777-7777-8777-7777777777a3';
/** The tenant's second number, so one contact holds two threads. */
const ACCOUNT_A2 = '75777777-7777-7777-8777-7777777777a4';
const CONVERSATION_A2 = '75777777-7777-7777-8777-7777777777a5';

const WABA_B = '75777777-7777-7777-8777-7777777777b0';
const ACCOUNT_B = '75777777-7777-7777-8777-7777777777b1';
const CONTACT_B = '75777777-7777-7777-8777-7777777777b2';
const CONVERSATION_B = '75777777-7777-7777-8777-7777777777b3';

const SENT_AT = new Date('2026-08-11T09:41:00.000Z');

describe('TicketLinker against a real database', () => {
  const tenantContext = new TenantContextService();
  const events = new EventEmitter2();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let linker: TicketLinkerService;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: 'tar75-int-spec', tenantId, userId: null },
      async () => await work(),
    );
  }

  function triggerFor(
    tenantId: string,
    conversationId: string,
    contactId: string,
    messageId: string,
  ): InboundMessageTicketTrigger {
    // Parsed rather than cast: this is the shape TAR-20 will emit, and a fixture
    // that has drifted from the published schema proves nothing.
    return InboundMessageTicketTriggerSchema.parse({
      tenantId,
      contactId,
      conversationId,
      messageId,
      receivedAt: SENT_AT.toISOString(),
    });
  }

  function link(tenantId: string, trigger: InboundMessageTicketTrigger): Promise<TicketLinkResult> {
    return asTenant(tenantId, () => linker.ensureTicketForMessage(trigger));
  }

  /** Records an inbound message the way TAR-20's writer would, and returns its id. */
  async function storeInboundMessage(
    tenantId: string,
    conversationId: string,
    providerMessageId: string,
  ): Promise<string> {
    const message = await systemPrisma.message.create({
      data: {
        tenantId,
        conversationId,
        direction: 'inbound',
        status: 'received',
        contentType: 'text',
        body: 'hello',
        providerMessageId,
        sentAt: SENT_AT,
      },
      select: { id: true },
    });

    return message.id;
  }

  function activeTicketsFor(contactId: string): Promise<{ id: string; number: number }[]> {
    return systemPrisma.ticket.findMany({
      where: { contactId, status: { in: ['open', 'pending'] } },
      select: { id: true, number: true },
    });
  }

  async function removeFixture(): Promise<void> {
    // Everything below cascades from the tenant, so one delete stays correct as
    // the schema grows.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);
    linker = new TicketLinkerService(tenantPrisma, tenantContext, events);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar75-fixture-a', name: 'TAR-75 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar75-fixture-b', name: 'TAR-75 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.whatsappBusinessAccount.createMany({
      data: [
        { id: WABA_A, tenantId: TENANT_A, wabaId: 'tar75-fixture-a-waba' },
        { id: WABA_B, tenantId: TENANT_B, wabaId: 'tar75-fixture-b-waba' },
      ],
    });
    await systemPrisma.whatsappAccount.createMany({
      data: [
        {
          id: ACCOUNT_A,
          tenantId: TENANT_A,
          whatsappBusinessAccountId: WABA_A,
          phoneNumberId: 'tar75-fixture-a-phone',
          displayPhoneNumber: '+10000000751',
        },
        {
          id: ACCOUNT_A2,
          tenantId: TENANT_A,
          whatsappBusinessAccountId: WABA_A,
          phoneNumberId: 'tar75-fixture-a-phone-2',
          displayPhoneNumber: '+10000000752',
        },
        {
          id: ACCOUNT_B,
          tenantId: TENANT_B,
          whatsappBusinessAccountId: WABA_B,
          phoneNumberId: 'tar75-fixture-b-phone',
          displayPhoneNumber: '+10000000753',
        },
      ],
    });
    await systemPrisma.contact.createMany({
      data: [
        { id: CONTACT_A, tenantId: TENANT_A, phoneE164: '+10000007501' },
        { id: CONTACT_B, tenantId: TENANT_B, phoneE164: '+10000007502' },
      ],
    });
    await systemPrisma.conversation.createMany({
      data: [
        {
          id: CONVERSATION_A,
          tenantId: TENANT_A,
          whatsappAccountId: ACCOUNT_A,
          contactId: CONTACT_A,
        },
        {
          id: CONVERSATION_A2,
          tenantId: TENANT_A,
          whatsappAccountId: ACCOUNT_A2,
          contactId: CONTACT_A,
        },
        {
          id: CONVERSATION_B,
          tenantId: TENANT_B,
          whatsappAccountId: ACCOUNT_B,
          contactId: CONTACT_B,
        },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    // Every case starts from "this contact has no ticket". Messages are recreated
    // per case; the counter is left alone deliberately, because numbers carry
    // over between cases exactly as they would between requests.
    await systemPrisma.ticket.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.message.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    events.removeAllListeners();
  });

  describe('the first inbound message from a contact', () => {
    it('creates one open ticket carrying an allocated number', async () => {
      const messageId = await storeInboundMessage(TENANT_A, CONVERSATION_A, 'tar75-a-1');

      const result = await link(
        TENANT_A,
        triggerFor(TENANT_A, CONVERSATION_A, CONTACT_A, messageId),
      );

      expect(result.outcome).toBe('created');
      expect(result.ticketNumber).toBeGreaterThan(0);

      const ticket = await systemPrisma.ticket.findUniqueOrThrow({
        where: { id: result.ticketId ?? '' },
        select: { status: true, conversationId: true, contactId: true, number: true },
      });

      expect(ticket).toMatchObject({
        status: 'open',
        conversationId: CONVERSATION_A,
        contactId: CONTACT_A,
        number: result.ticketNumber,
      });
    });

    it('announces the new ticket once the transaction has committed', async () => {
      const announced: TicketCreatedEvent[] = [];
      events.on(TICKET_CREATED_EVENT, (event: TicketCreatedEvent) => announced.push(event));

      const messageId = await storeInboundMessage(TENANT_A, CONVERSATION_A, 'tar75-a-2');
      const result = await link(
        TENANT_A,
        triggerFor(TENANT_A, CONVERSATION_A, CONTACT_A, messageId),
      );

      expect(announced).toEqual([
        {
          tenantId: TENANT_A,
          ticketId: result.ticketId,
          ticketNumber: result.ticketNumber,
          contactId: CONTACT_A,
          conversationId: CONVERSATION_A,
        },
      ]);
      // Committed by the time the event fired, which is the ordering that stops
      // a rolled-back ticket reaching an agent's screen.
      await expect(
        systemPrisma.ticket.count({ where: { id: result.ticketId ?? '' } }),
      ).resolves.toBe(1);
    });
  });

  describe('concurrent messages from the same contact', () => {
    it('produces exactly one ticket — one create, one attach, no error', async () => {
      // The case TAR-21 exists to prevent, and the reason the create path is one
      // conflict-tolerant statement: a customer sending two messages in a row
      // produces two near-simultaneous jobs for the same contact.
      const [first, second] = await Promise.all([
        storeInboundMessage(TENANT_A, CONVERSATION_A, 'tar75-race-1'),
        storeInboundMessage(TENANT_A, CONVERSATION_A, 'tar75-race-2'),
      ]);

      const results = await Promise.all([
        link(TENANT_A, triggerFor(TENANT_A, CONVERSATION_A, CONTACT_A, first)),
        link(TENANT_A, triggerFor(TENANT_A, CONVERSATION_A, CONTACT_A, second)),
      ]);

      expect(results.map((result) => result.outcome).sort()).toEqual(['attached', 'created']);
      // Both calls answer with the same ticket: the loser attached to the winner
      // rather than reporting a conflict to its caller.
      expect(new Set(results.map((result) => result.ticketId)).size).toBe(1);
      expect(await activeTicketsFor(CONTACT_A)).toHaveLength(1);
    });

    it('stays at one ticket across a burst', async () => {
      const messageIds = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          storeInboundMessage(TENANT_A, CONVERSATION_A, `tar75-burst-${index}`),
        ),
      );

      const results = await Promise.all(
        messageIds.map((messageId) =>
          link(TENANT_A, triggerFor(TENANT_A, CONVERSATION_A, CONTACT_A, messageId)),
        ),
      );

      expect(results.filter((result) => result.outcome === 'created')).toHaveLength(1);
      expect(await activeTicketsFor(CONTACT_A)).toHaveLength(1);
    });

    it('is idempotent for the same message', async () => {
      // Delivery is at-least-once: a Meta retry, a sweeper re-enqueue and an
      // expired job lock all replay the same trigger.
      const messageId = await storeInboundMessage(TENANT_A, CONVERSATION_A, 'tar75-replay');
      const trigger = triggerFor(TENANT_A, CONVERSATION_A, CONTACT_A, messageId);

      const first = await link(TENANT_A, trigger);
      const second = await link(TENANT_A, trigger);

      expect(first.outcome).toBe('created');
      expect(second).toMatchObject({ outcome: 'attached', ticketId: first.ticketId });
      expect(await activeTicketsFor(CONTACT_A)).toHaveLength(1);
    });
  });

  describe('a contact who already has a ticket', () => {
    it('reopens a pending one and reports the status the SLA timer needs', async () => {
      const opening = await storeInboundMessage(TENANT_A, CONVERSATION_A, 'tar75-pending-1');
      const created = await link(
        TENANT_A,
        triggerFor(TENANT_A, CONVERSATION_A, CONTACT_A, opening),
      );
      await systemPrisma.ticket.update({
        where: { id: created.ticketId ?? '' },
        data: { status: 'pending' },
      });

      const reply = await storeInboundMessage(TENANT_A, CONVERSATION_A, 'tar75-pending-2');
      const result = await link(TENANT_A, triggerFor(TENANT_A, CONVERSATION_A, CONTACT_A, reply));

      expect(result).toMatchObject({
        outcome: 'attached',
        ticketId: created.ticketId,
        previousStatus: 'pending',
      });
      await expect(
        systemPrisma.ticket.findUniqueOrThrow({
          where: { id: created.ticketId ?? '' },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: 'open' });
      await expect(
        systemPrisma.ticketEvent.count({
          where: { ticketId: created.ticketId ?? '', type: 'status_changed' },
        }),
      ).resolves.toBe(1);
    });

    it('records a conversation_linked event for a message on another number', async () => {
      const first = await storeInboundMessage(TENANT_A, CONVERSATION_A, 'tar75-multi-1');
      const created = await link(TENANT_A, triggerFor(TENANT_A, CONVERSATION_A, CONTACT_A, first));

      const second = await storeInboundMessage(TENANT_A, CONVERSATION_A2, 'tar75-multi-2');
      const result = await link(TENANT_A, triggerFor(TENANT_A, CONVERSATION_A2, CONTACT_A, second));

      expect(result).toMatchObject({ outcome: 'attached', ticketId: created.ticketId });
      await expect(
        systemPrisma.ticketEvent.count({
          where: { ticketId: created.ticketId ?? '', type: 'conversation_linked' },
        }),
      ).resolves.toBe(1);
      // The ticket keeps pointing at the conversation it was opened from.
      await expect(
        systemPrisma.ticket.findUniqueOrThrow({
          where: { id: created.ticketId ?? '' },
          select: { conversationId: true },
        }),
      ).resolves.toEqual({ conversationId: CONVERSATION_A });
    });

    it.each(['resolved', 'closed'] as const)(
      'opens a new ticket once the previous one is %s',
      async (terminal) => {
        const first = await storeInboundMessage(TENANT_A, CONVERSATION_A, `tar75-${terminal}-1`);
        const created = await link(
          TENANT_A,
          triggerFor(TENANT_A, CONVERSATION_A, CONTACT_A, first),
        );
        await systemPrisma.ticket.update({
          where: { id: created.ticketId ?? '' },
          data: { status: terminal },
        });

        const second = await storeInboundMessage(TENANT_A, CONVERSATION_A, `tar75-${terminal}-2`);
        const result = await link(
          TENANT_A,
          triggerFor(TENANT_A, CONVERSATION_A, CONTACT_A, second),
        );

        // No reopen window at v1 (0003, open question 1).
        expect(result.outcome).toBe('created');
        expect(result.ticketId).not.toBe(created.ticketId);
        expect(await activeTicketsFor(CONTACT_A)).toHaveLength(1);
      },
    );
  });

  describe('tenant isolation', () => {
    it('numbers each tenant’s tickets independently and never crosses between them', async () => {
      const [inA, inB] = await Promise.all([
        storeInboundMessage(TENANT_A, CONVERSATION_A, 'tar75-iso-a'),
        storeInboundMessage(TENANT_B, CONVERSATION_B, 'tar75-iso-b'),
      ]);

      const results = await Promise.all([
        link(TENANT_A, triggerFor(TENANT_A, CONVERSATION_A, CONTACT_A, inA)),
        link(TENANT_B, triggerFor(TENANT_B, CONVERSATION_B, CONTACT_B, inB)),
      ]);

      expect(results.map((result) => result.outcome)).toEqual(['created', 'created']);
      expect(await activeTicketsFor(CONTACT_A)).toHaveLength(1);
      expect(await activeTicketsFor(CONTACT_B)).toHaveLength(1);

      const inTenantA = await systemPrisma.ticket.findMany({
        where: { tenantId: TENANT_A },
        select: { contactId: true },
      });

      expect(inTenantA).toEqual([{ contactId: CONTACT_A }]);
    });

    it('refuses a trigger naming another tenant’s message', async () => {
      // The forged-payload case. The read runs under RLS in tenant A's scope, so
      // tenant B's message is simply not there — and a job that cannot see its
      // message throws rather than inventing a ticket.
      const inB = await storeInboundMessage(TENANT_B, CONVERSATION_B, 'tar75-forged');

      await expect(
        link(TENANT_A, triggerFor(TENANT_B, CONVERSATION_B, CONTACT_B, inB)),
      ).rejects.toThrow(/is not visible in the tenant in scope/);

      expect(await activeTicketsFor(CONTACT_B)).toHaveLength(0);
    });
  });

  describe('an outbound message', () => {
    it('is skipped, and writes nothing', async () => {
      const outbound = await systemPrisma.message.create({
        data: {
          tenantId: TENANT_A,
          conversationId: CONVERSATION_A,
          direction: 'outbound',
          status: 'sent',
          contentType: 'text',
          body: 'an agent reply',
          providerMessageId: 'tar75-outbound',
          sentAt: SENT_AT,
        },
        select: { id: true },
      });

      const result = await link(
        TENANT_A,
        triggerFor(TENANT_A, CONVERSATION_A, CONTACT_A, outbound.id),
      );

      expect(result).toEqual({
        outcome: 'skipped',
        ticketId: null,
        ticketNumber: null,
        previousStatus: null,
        reason: 'not_inbound',
      });
      expect(await activeTicketsFor(CONTACT_A)).toHaveLength(0);
    });
  });
});

/** Loaded from the repository-root `.env` by `jest.int.setup.cjs`. */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. These tests need a real database: ` +
        'copy .env.example to .env and run pnpm db:up && pnpm db:migrate:deploy && ' +
        'pnpm db:roles && pnpm db:roles:login.',
    );
  }

  return value;
}
