import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  TICKET_ENSURE_JOB,
  TICKET_QUEUE,
  type InboundMessageTicketTrigger,
} from '@whatsappcrm/contracts';
import type { Job } from 'bullmq';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { WEBHOOKS_QUEUE } from '../queue/queue.constants';
import type { JobHandler, JobHandlers, QueueService } from '../queue/queue.service';
import { WebhookEventsRepository } from '../webhooks/webhook-events.repository';
import { WebhookIngestService } from '../webhooks/webhook-ingest.service';
import { WhatsAppAccountResolver } from '../webhooks/whatsapp-account.resolver';
import { WhatsAppEventProcessor } from '../webhooks/whatsapp-event.processor';
import { PlanLimitsService } from '../entitlements/plan-limits.service';
import { UsageCounterService } from '../entitlements/usage-counter.service';
import { volumePolicyConfig } from '../entitlements/volume-policy.test-config';
import { UsagePeriodResolver } from '../entitlements/usage-period.resolver';
import { WhatsAppInboundWriter } from '../webhooks/whatsapp-inbound.writer';
import { TicketLinkerService } from './ticket-linker.service';
import { TicketQueueRunner } from './ticket-queue.runner';

/**
 * TAR-77 end to end: a signed WhatsApp delivery arrives and a ticket exists at
 * the other end of it.
 *
 * This is the file that answers TAR-77's acceptance criteria, and it is
 * deliberately assembled from the **real** classes on both sides of the queue —
 * `WebhookIngestService` → `WhatsAppEventProcessor` → `WhatsAppInboundWriter`
 * produces the trigger, `TicketQueueRunner` → `TicketLinkerService` consumes it,
 * against a real PostgreSQL with TAR-48's policies and TAR-74's partial unique
 * index in force. Nothing about the linking is mocked; TAR-75's own specs prove
 * it in isolation, and what is at issue here is whether the two halves TAR-73
 * kept apart actually meet.
 *
 * **Redis is the one substituted collaborator**, exactly as in
 * `webhook-ingestion.int-spec.ts` and for the same reason: BullMQ's delivery is
 * covered by its own library's tests, and standing up Redis here would test
 * transport rather than the pipeline behaviour at issue. The substitution is
 * kept honest — `drainTicketTriggers` runs the handler the runner registered,
 * with the payload the writer enqueued, inside the tenant scope `QueueService`
 * would have opened from `job.data.tenantId`. If the producer and the consumer
 * disagreed about the payload shape, this file would fail.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Every fixture row
 * carries a `tar77-fixture` slug or a `tar77-` marker inside its payload, and is
 * removed before the run as well as after it, so an interrupted run cleans up on
 * the next one. Point `pnpm test:db` at a local or disposable database.
 *
 * Prerequisites — the four commands in the README:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const FIXTURE_PREFIX = 'tar77-fixture';
const PAYLOAD_MARKER = 'tar77-';
const APP_SECRET = 'tar77-app-secret';
const REQUEST_ID = 'tar77-int-spec';

const TENANT_A = '77444444-4444-7444-8444-444444444401';
const TENANT_B = '77444444-4444-7444-8444-444444444402';
const WABA_A = '77444444-4444-7444-8444-4444444444a1';
const WABA_B = '77444444-4444-7444-8444-4444444444a2';
const ACCOUNT_A = '77444444-4444-7444-8444-4444444444b1';
const ACCOUNT_B = '77444444-4444-7444-8444-4444444444b2';

const PHONE_NUMBER_A = 'tar77-pn-a';
const PHONE_NUMBER_B = 'tar77-pn-b';

/**
 * One customer number per scenario, so each block owns its own contact, thread
 * and ticket. The file therefore passes in any order, and "exactly one ticket"
 * means what it says rather than depending on what ran before it.
 */
const CUSTOMER = {
  firstContact: '966502220001',
  followUp: '966502220002',
  reopened: '966502220003',
  resolved: '966502220004',
  outbound: '966502220005',
  replay: '966502220006',
  /** Deliberately shared: the same human number written to both tenants. */
  shared: '966502220007',
} as const;

const ENV: Record<string, unknown> = {
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'tar77-verify-token',
  WEBHOOK_MAX_ATTEMPTS: 5,
  WEBHOOK_STUCK_AFTER_MS: 60_000,
  WEBHOOK_SWEEP_INTERVAL_MS: 30_000,
  MEDIA_DOWNLOAD_MAX_ATTEMPTS: 3,
  TICKET_LINK_MAX_ATTEMPTS: 5,
};

const CONFIG = {
  get: (key: string) => ENV[key],
  getOrThrow: (key: string) => ENV[key],
} as unknown as ConfigService;

interface InboundOptions {
  readonly phoneNumberId?: string;
  readonly from: string;
  readonly wamid: string;
  readonly body: string;
  readonly at: Date;
}

function inboundPayload({
  phoneNumberId = PHONE_NUMBER_A,
  from,
  wamid,
  body,
  at,
}: InboundOptions): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: `waba-${phoneNumberId}`,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+15550001111', phone_number_id: phoneNumberId },
              messages: [
                {
                  id: wamid,
                  from,
                  timestamp: String(Math.floor(at.getTime() / 1_000)),
                  type: 'text',
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** A delivery receipt for a message *we* sent — outbound, and never a ticket. */
function statusPayload(options: { wamid: string; at: Date; recipient: string }): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: `waba-${PHONE_NUMBER_A}`,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_NUMBER_A },
              statuses: [
                {
                  id: options.wamid,
                  status: 'delivered',
                  timestamp: String(Math.floor(options.at.getTime() / 1_000)),
                  recipient_id: options.recipient,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('auto-ticket creation from a real inbound delivery', () => {
  const tenantContext = new TenantContextService();
  const emitter = new EventEmitter2();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let ingest: WebhookIngestService;
  let processor: WhatsAppEventProcessor;
  let ticketHandler: JobHandler<InboundMessageTicketTrigger>;

  /** Everything the pipeline handed to the queue, in the order it did. */
  let webhookJobs: { webhookEventId: string }[];
  let ticketTriggers: InboundMessageTicketTrigger[];

  /** Reads as the application does: through `TenantPrisma`, in one tenant's scope. */
  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null },
      async () => await work(),
    );
  }

  /**
   * Signed HTTP body → stored row → worker, the whole path a real delivery
   * takes. Returns the `webhook_events` id so a caller can prove two deliveries
   * were genuinely two.
   *
   * Throws rather than returning quietly when nothing was enqueued: a
   * byte-identical payload is absorbed by the ingest layer's own deduplication
   * and never reaches the processor at all, which would make a test that
   * expected the *writer's* replay path pass without ever entering it.
   */
  async function deliver(payload: unknown): Promise<string> {
    const before = webhookJobs.length;
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;

    await ingest.ingestWhatsApp(raw, signature);

    const job = webhookJobs.at(-1);

    if (job === undefined || webhookJobs.length === before) {
      throw new Error(
        'The delivery enqueued no webhook job — the ingest layer treated it as a duplicate ' +
          'of an earlier payload, so the processor never ran.',
      );
    }

    await tenantContext.run(
      { requestId: REQUEST_ID, tenantId: null, userId: null },
      async () => await processor.process(job.webhookEventId),
    );

    return job.webhookEventId;
  }

  /**
   * Runs every ticket trigger the pipeline produced, the way BullMQ would.
   *
   * The tenant scope is opened here rather than by the handler because that is
   * where it is opened in production — `QueueService.runInTenantScope`, from
   * `job.data.tenantId`. Reproducing it is what keeps this substitution honest:
   * a runner that quietly depended on an ambient scope would pass a test that
   * left one open, and fail on the real queue.
   */
  async function drainTicketTriggers(): Promise<number> {
    const pending = ticketTriggers.splice(0, ticketTriggers.length);

    for (const trigger of pending) {
      await tenantContext.run(
        {
          requestId: `job:${TICKET_ENSURE_JOB}:int-spec`,
          tenantId: trigger.tenantId,
          userId: null,
        },
        async () =>
          await ticketHandler({
            name: TICKET_ENSURE_JOB,
            data: trigger,
          } as Job<InboundMessageTicketTrigger>),
      );
    }

    return pending.length;
  }

  /** One signed inbound message, all the way through to its ticket. */
  async function inbound(options: InboundOptions): Promise<void> {
    await deliver(inboundPayload(options));
    await drainTicketTriggers();
  }

  /** `waId` as Meta sends it; ingest stores the E.164 form, which carries a `+`. */
  async function ticketsFor(tenantId: string, waId: string) {
    return await asTenant(tenantId, async () =>
      tenantPrisma.ticket.findMany({
        where: { tenantId, contact: { phoneE164: `+${waId}` } },
        select: {
          id: true,
          number: true,
          status: true,
          contactId: true,
          conversationId: true,
        },
        orderBy: { number: 'asc' },
      }),
    );
  }

  async function removeFixture(): Promise<void> {
    // Contacts, conversations, messages, tickets and ticket_counters all cascade
    // from `tenants`.
    await systemPrisma.tenant.deleteMany({ where: { slug: { startsWith: FIXTURE_PREFIX } } });
    await systemPrisma.$executeRaw`DELETE FROM webhook_events WHERE payload::text LIKE ${`%${PAYLOAD_MARKER}%`}`;
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    webhookJobs = [];
    ticketTriggers = [];

    const enqueue = jest.fn((queueName: string, _job: string, data: unknown) => {
      if (queueName === TICKET_QUEUE) {
        ticketTriggers.push(data as InboundMessageTicketTrigger);
      } else if (queueName === WEBHOOKS_QUEUE) {
        webhookJobs.push(data as { webhookEventId: string });
      }

      return Promise.resolve('added' as const);
    });

    const registerWorker = jest.fn(
      ({ handlers }: { handlers: JobHandlers<InboundMessageTicketTrigger> }) => {
        const registered = handlers[TICKET_ENSURE_JOB];

        if (registered === undefined) {
          throw new Error(`The runner registered no handler for ${TICKET_ENSURE_JOB}`);
        }

        ticketHandler = registered;

        return true;
      },
    );

    const queue = { enqueue, registerWorker } as unknown as QueueService;
    const repository = new WebhookEventsRepository(systemPrisma);

    ingest = new WebhookIngestService(CONFIG, repository, queue);
    processor = new WhatsAppEventProcessor(
      CONFIG,
      repository,
      new WhatsAppAccountResolver(systemPrisma),
      new WhatsAppInboundWriter(
        CONFIG,
        tenantPrisma,
        emitter,
        queue,
        new UsageCounterService(new UsagePeriodResolver()),
        new PlanLimitsService(
          volumePolicyConfig(),
          new UsageCounterService(new UsagePeriodResolver()),
        ),
      ),
      tenantContext,
    );

    new TicketQueueRunner(
      queue,
      new TicketLinkerService(tenantPrisma, tenantContext, emitter),
    ).onApplicationBootstrap();

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: `${FIXTURE_PREFIX}-a`, name: 'TAR-77 tenant A', status: 'active' },
        { id: TENANT_B, slug: `${FIXTURE_PREFIX}-b`, name: 'TAR-77 tenant B', status: 'active' },
      ],
    });

    await systemPrisma.whatsappBusinessAccount.createMany({
      data: [
        { id: WABA_A, tenantId: TENANT_A, wabaId: `${PAYLOAD_MARKER}waba-a` },
        { id: WABA_B, tenantId: TENANT_B, wabaId: `${PAYLOAD_MARKER}waba-b` },
      ],
    });

    await systemPrisma.whatsappAccount.createMany({
      data: [
        {
          id: ACCOUNT_A,
          tenantId: TENANT_A,
          whatsappBusinessAccountId: WABA_A,
          phoneNumberId: PHONE_NUMBER_A,
          displayPhoneNumber: '+15550001111',
        },
        {
          id: ACCOUNT_B,
          tenantId: TENANT_B,
          whatsappBusinessAccountId: WABA_B,
          phoneNumberId: PHONE_NUMBER_B,
          displayPhoneNumber: '+15550002222',
        },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  describe('a customer who has never written before', () => {
    it('gets an open ticket linked to the conversation the message created', async () => {
      await inbound({
        from: CUSTOMER.firstContact,
        wamid: 'wamid.tar77.first',
        body: 'my order has not arrived',
        at: new Date('2026-08-12T09:00:00.000Z'),
      });

      const [ticket, ...extra] = await ticketsFor(TENANT_A, CUSTOMER.firstContact);

      expect(extra).toHaveLength(0);
      expect(ticket).toMatchObject({ status: 'open' });
      expect(ticket?.number).toBeGreaterThan(0);

      const conversation = await asTenant(TENANT_A, async () =>
        tenantPrisma.conversation.findFirstOrThrow({
          where: { tenantId: TENANT_A, contact: { phoneE164: `+${CUSTOMER.firstContact}` } },
          select: { id: true, contactId: true },
        }),
      );

      // Linked to the real rows the pipeline wrote, not to ids the payload
      // asserted — which is the whole reason the linker re-reads the message.
      expect(ticket?.conversationId).toBe(conversation.id);
      expect(ticket?.contactId).toBe(conversation.contactId);
    });
  });

  describe('a follow-up from the same customer', () => {
    it('attaches to the open ticket instead of opening a second one', async () => {
      const base = { from: CUSTOMER.followUp, body: 'still waiting' };

      await inbound({
        ...base,
        wamid: 'wamid.tar77.follow-1',
        at: new Date('2026-08-12T09:10:00.000Z'),
      });

      const [first] = await ticketsFor(TENANT_A, CUSTOMER.followUp);

      await inbound({
        ...base,
        wamid: 'wamid.tar77.follow-2',
        at: new Date('2026-08-12T09:11:00.000Z'),
      });
      await inbound({
        ...base,
        wamid: 'wamid.tar77.follow-3',
        at: new Date('2026-08-12T09:12:00.000Z'),
      });

      const tickets = await ticketsFor(TENANT_A, CUSTOMER.followUp);

      expect(tickets).toHaveLength(1);
      expect(tickets[0]?.id).toBe(first?.id);
      expect(tickets[0]?.status).toBe('open');
    });
  });

  describe('a customer replying to a ticket that was waiting on them', () => {
    /**
     * `pending` counts as active (0003, decision 2), so the reply lands on the
     * same ticket — and reopens it, which is TAR-26's cue to resume a paused SLA
     * timer.
     */
    it('reopens the pending ticket rather than opening a new one', async () => {
      await inbound({
        from: CUSTOMER.reopened,
        wamid: 'wamid.tar77.reopen-1',
        body: 'can you check this',
        at: new Date('2026-08-12T09:20:00.000Z'),
      });

      const [opened] = await ticketsFor(TENANT_A, CUSTOMER.reopened);

      await asTenant(TENANT_A, async () =>
        tenantPrisma.ticket.updateMany({
          where: { tenantId: TENANT_A, id: opened?.id },
          data: { status: 'pending' },
        }),
      );

      await inbound({
        from: CUSTOMER.reopened,
        wamid: 'wamid.tar77.reopen-2',
        body: 'any news?',
        at: new Date('2026-08-12T09:25:00.000Z'),
      });

      const tickets = await ticketsFor(TENANT_A, CUSTOMER.reopened);

      expect(tickets).toHaveLength(1);
      expect(tickets[0]).toMatchObject({ id: opened?.id, status: 'open' });
    });
  });

  describe('a customer writing back after their ticket was resolved', () => {
    /**
     * `resolved` is terminal, so this is a new piece of work and gets a new
     * ticket. 0003 records the absence of a reopen window as deliberate at v1.
     */
    it('gets a second ticket, because resolved is terminal', async () => {
      await inbound({
        from: CUSTOMER.resolved,
        wamid: 'wamid.tar77.resolved-1',
        body: 'thanks, sorted',
        at: new Date('2026-08-12T09:30:00.000Z'),
      });

      const [first] = await ticketsFor(TENANT_A, CUSTOMER.resolved);

      await asTenant(TENANT_A, async () =>
        tenantPrisma.ticket.updateMany({
          where: { tenantId: TENANT_A, id: first?.id },
          data: { status: 'resolved', resolvedAt: new Date() },
        }),
      );

      await inbound({
        from: CUSTOMER.resolved,
        wamid: 'wamid.tar77.resolved-2',
        body: 'actually, one more thing',
        at: new Date('2026-08-12T09:40:00.000Z'),
      });

      const tickets = await ticketsFor(TENANT_A, CUSTOMER.resolved);

      expect(tickets).toHaveLength(2);
      expect(tickets.map((ticket) => ticket.status)).toEqual(['resolved', 'open']);
    });
  });

  describe('a delivery receipt for a message we sent', () => {
    /**
     * The placeholder `applyStatusUpdate` writes is outbound. It must not reach
     * the queue at all: the linker would only skip it, and a job whose one
     * possible outcome is `skipped` is a round trip that buys nothing.
     */
    it('never enqueues a ticket trigger', async () => {
      await deliver(
        statusPayload({
          wamid: 'wamid.tar77.outbound',
          at: new Date('2026-08-12T09:50:00.000Z'),
          recipient: CUSTOMER.outbound,
        }),
      );

      expect(ticketTriggers).toHaveLength(0);
      expect(await ticketsFor(TENANT_A, CUSTOMER.outbound)).toHaveLength(0);
    });
  });

  describe('the same message delivered twice', () => {
    /**
     * The gap this closes: the message write and the ticket trigger are not one
     * atomic unit, so a worker that commits the message and then dies leaves a
     * message with no ticket, and the sweeper's replay is the only thing that
     * will revisit it. On that replay `skipDuplicates` writes nothing — so the
     * trigger has to be enqueued from a message id read back, not from the
     * insert. Without it, that message silently never becomes a ticket.
     */
    it('still enqueues a trigger for the replay, and still opens exactly one ticket', async () => {
      const message = {
        from: CUSTOMER.replay,
        wamid: 'wamid.tar77.replay',
        body: 'hello twice',
        at: new Date('2026-08-12T10:00:00.000Z'),
      };

      const firstEvent = await deliver(inboundPayload(message));

      expect(ticketTriggers).toHaveLength(1);
      const [firstTrigger] = ticketTriggers;
      await drainTicketTriggers();

      // A second delivery carrying the same `wamid`. The body differs so the
      // ingest layer stores it as its own event rather than absorbing it — what
      // reaches the writer is then a message it has already recorded, which is
      // exactly the state a sweeper replay leaves it in.
      const secondEvent = await deliver(
        inboundPayload({ ...message, body: 'hello twice, differently worded' }),
      );

      expect(secondEvent).not.toBe(firstEvent);
      expect(ticketTriggers).toHaveLength(1);
      expect(ticketTriggers[0]?.messageId).toBe(firstTrigger?.messageId);

      await drainTicketTriggers();

      const tickets = await ticketsFor(TENANT_A, CUSTOMER.replay);

      expect(tickets).toHaveLength(1);
      expect(tickets[0]?.status).toBe('open');
    });
  });

  describe('two tenants reached by the same customer number', () => {
    /**
     * The isolation assertion TAR-77 exists to keep true under real webhook
     * traffic: the same human writes to both businesses, and each gets its own
     * contact, its own thread and its own ticket. A ticket that linked across
     * would be a cross-tenant leak, not a bug.
     */
    it('gives each tenant its own ticket, and neither can see the other', async () => {
      await inbound({
        from: CUSTOMER.shared,
        wamid: 'wamid.tar77.shared-a',
        body: 'writing to business A',
        at: new Date('2026-08-12T10:10:00.000Z'),
      });

      await inbound({
        phoneNumberId: PHONE_NUMBER_B,
        from: CUSTOMER.shared,
        wamid: 'wamid.tar77.shared-b',
        body: 'writing to business B',
        at: new Date('2026-08-12T10:11:00.000Z'),
      });

      const inA = await ticketsFor(TENANT_A, CUSTOMER.shared);
      const inB = await ticketsFor(TENANT_B, CUSTOMER.shared);

      expect(inA).toHaveLength(1);
      expect(inB).toHaveLength(1);
      expect(inA[0]?.id).not.toBe(inB[0]?.id);
      expect(inA[0]?.contactId).not.toBe(inB[0]?.contactId);

      // Read as the application reads, through `TenantPrisma`: tenant A's scope
      // must not return tenant B's ticket even when asked for it by id.
      const leaked = await asTenant(TENANT_A, async () =>
        tenantPrisma.ticket.findMany({
          where: { id: inB[0]?.id },
          select: { id: true },
        }),
      );

      expect(leaked).toHaveLength(0);
    });

    /** Ticket numbers are per tenant: both tenants owning a #1 is correct. */
    it('numbers tickets per tenant rather than globally', async () => {
      const numbers = await asTenant(TENANT_B, async () =>
        tenantPrisma.ticket.findMany({
          where: { tenantId: TENANT_B },
          select: { number: true },
        }),
      );

      expect(numbers).not.toHaveLength(0);
      expect(Math.min(...numbers.map((ticket) => ticket.number))).toBe(1);
    });
  });
});

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
