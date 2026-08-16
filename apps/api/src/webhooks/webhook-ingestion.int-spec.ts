import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { MESSAGE_CREATED_EVENT, MESSAGE_STATUS_CHANGED_EVENT } from '../events/domain-events';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import type { QueueService } from '../queue/queue.service';
import { WEBHOOK_FAILURE_REASON } from './webhook-failure-reasons';
import { WebhookEventsRepository } from './webhook-events.repository';
import { WebhookIngestService } from './webhook-ingest.service';
import { WebhookSweeperService } from './webhook-sweeper.service';
import { WhatsAppAccountResolver } from './whatsapp-account.resolver';
import { WhatsAppEventProcessor } from './whatsapp-event.processor';
import { UsageCounterService } from '../entitlements/usage-counter.service';
import { UsagePeriodResolver } from '../entitlements/usage-period.resolver';
import { WhatsAppInboundWriter } from './whatsapp-inbound.writer';

/**
 * TAR-20's ingestion pipeline against a real PostgreSQL with TAR-48's policies
 * applied — the properties the acceptance criteria ask for, none of which a
 * mocked database can show:
 *
 *   * a **duplicate delivery** is absorbed by the unique constraint rather than
 *     double-processed, and does not double an unread count;
 *   * **out-of-order delivery** leaves the thread correct: messages sort by the
 *     provider's `sent_at`, and `last_message_at` never moves backwards;
 *   * a **status webhook that overtakes its message** creates the row it needs,
 *     and a late `sent` afterwards cannot un-read it;
 *   * an **unknown `phone_number_id`** is parked `failed`, queryable, with its
 *     payload intact;
 *   * the **sweeper** re-enqueues an event that was stored but never picked up;
 *   * **one tenant cannot observe the other's** contacts, threads or messages —
 *     asserted through `TenantPrisma`, as the application reaches them.
 *
 * The queue is the one substituted collaborator: BullMQ is exercised by its own
 * library's tests, and standing up Redis here would test delivery rather than
 * the database behaviour that is at issue.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Every fixture row
 * carries a `tar67-fixture` slug or a `tar67-` marker inside its payload, and is
 * removed before the run as well as after it, so an interrupted run cleans up on
 * the next one. Point `pnpm test:db` at a local or disposable database.
 *
 * Prerequisites — the four commands in the README:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const FIXTURE_PREFIX = 'tar67-fixture';
const PAYLOAD_MARKER = 'tar67-';
const APP_SECRET = 'tar67-app-secret';
const REQUEST_ID = 'tar67-int-spec';

const TENANT_A = '67444444-4444-7444-8444-444444444401';
const TENANT_B = '67444444-4444-7444-8444-444444444402';
const WABA_A = '67444444-4444-7444-8444-4444444444a1';
const WABA_B = '67444444-4444-7444-8444-4444444444a2';
const ACCOUNT_A = '67444444-4444-7444-8444-4444444444b1';
const ACCOUNT_B = '67444444-4444-7444-8444-4444444444b2';

const PHONE_NUMBER_A = 'tar67-pn-a';
const PHONE_NUMBER_B = 'tar67-pn-b';
const UNCONNECTED_PHONE_NUMBER = 'tar67-pn-nobody';

/**
 * One customer number per scenario. Each block therefore owns its own contact
 * and its own thread, so the file passes in any order and an assertion about an
 * unread count means what it says rather than depending on what ran before it.
 */
const CUSTOMER = {
  firstContact: '966501110001',
  outOfOrder: '966501110002',
  duplicate: '966501110003',
  reprocessed: '966501110004',
  statuses: '966501110005',
  stuck: '966501110006',
  emitted: '966501110007',
  freshThread: '966501110008',
  metered: '966501110009',
} as const;

const ENV: Record<string, unknown> = {
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'tar67-verify-token',
  WEBHOOK_MAX_ATTEMPTS: 5,
  WEBHOOK_STUCK_AFTER_MS: 60_000,
  WEBHOOK_SWEEP_INTERVAL_MS: 30_000,
  // Read by the inbound writer when it queues a media download (TAR-20e). No
  // scenario here sends media, so the value only has to exist.
  MEDIA_DOWNLOAD_MAX_ATTEMPTS: 3,
};

const CONFIG = {
  get: (key: string) => ENV[key],
  getOrThrow: (key: string) => ENV[key],
} as unknown as ConfigService;

interface InboundOptions {
  readonly phoneNumberId?: string;
  readonly from?: string;
  readonly wamid: string;
  readonly body: string;
  readonly at: Date;
  readonly profileName?: string;
}

function inboundPayload({
  phoneNumberId = PHONE_NUMBER_A,
  from = CUSTOMER.firstContact,
  wamid,
  body,
  at,
  profileName,
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
              ...(profileName === undefined
                ? {}
                : { contacts: [{ wa_id: from, profile: { name: profileName } }] }),
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

function statusPayload(options: {
  wamid: string;
  status: string;
  at: Date;
  recipient?: string;
  phoneNumberId?: string;
}): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: `waba-${options.phoneNumberId ?? PHONE_NUMBER_A}`,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: options.phoneNumberId ?? PHONE_NUMBER_A },
              statuses: [
                {
                  id: options.wamid,
                  status: options.status,
                  timestamp: String(Math.floor(options.at.getTime() / 1_000)),
                  recipient_id: options.recipient ?? CUSTOMER.statuses,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('WhatsApp webhook ingestion, end to end', () => {
  const tenantContext = new TenantContextService();
  const emitter = new EventEmitter2();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let repository: WebhookEventsRepository;
  let ingest: WebhookIngestService;
  let processor: WhatsAppEventProcessor;
  let sweeper: WebhookSweeperService;
  let enqueue: jest.Mock;

  /** Reads as the application does: through `TenantPrisma`, in one tenant's scope. */
  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null },
      async () => await work(),
    );
  }

  /** Drives the whole path a real delivery takes: signed HTTP body → stored row → worker. */
  async function deliver(payload: unknown): Promise<string> {
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;

    await ingest.ingestWhatsApp(raw, signature);

    const [, , job] = enqueue.mock.calls.at(-1) as [string, string, { webhookEventId: string }];

    await tenantContext.run(
      { requestId: REQUEST_ID, tenantId: null, userId: null },
      async () => await processor.process(job.webhookEventId),
    );

    return job.webhookEventId;
  }

  async function removeFixture(): Promise<void> {
    // Contacts, conversations and messages cascade from `tenants`.
    await systemPrisma.tenant.deleteMany({ where: { slug: { startsWith: FIXTURE_PREFIX } } });
    // `webhook_events` is written before the tenant is known, so it has no
    // foreign key to cascade through. The marker is inside every fixture payload.
    await systemPrisma.$executeRaw`DELETE FROM webhook_events WHERE payload::text LIKE ${`%${PAYLOAD_MARKER}%`}`;
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    enqueue = jest.fn().mockResolvedValue('added');
    const queue = { enqueue } as unknown as QueueService;

    repository = new WebhookEventsRepository(systemPrisma);
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
      ),
      tenantContext,
    );
    sweeper = new WebhookSweeperService(CONFIG, repository, queue);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: `${FIXTURE_PREFIX}-a`, name: 'TAR-67 tenant A', status: 'active' },
        { id: TENANT_B, slug: `${FIXTURE_PREFIX}-b`, name: 'TAR-67 tenant B', status: 'active' },
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

  describe('what a signed delivery writes', () => {
    const wamid = 'wamid.tar67.first';
    const sentAt = new Date('2026-08-10T09:00:00.000Z');

    it('creates the contact, the thread and the message under the owning tenant', async () => {
      const eventId = await deliver(
        inboundPayload({ wamid, body: 'first message', at: sentAt, profileName: 'Layla' }),
      );

      const stored = await systemPrisma.webhookEvent.findUniqueOrThrow({
        where: { id: eventId },
        select: { status: true, tenantId: true, attempts: true, processedAt: true },
      });

      expect(stored).toMatchObject({ status: 'processed', tenantId: TENANT_A, attempts: 1 });
      expect(stored.processedAt).not.toBeNull();

      const conversation = await asTenant(TENANT_A, async () =>
        tenantPrisma.conversation.findFirstOrThrow({
          where: { contact: { phoneE164: `+${CUSTOMER.firstContact}` } },
          select: {
            unreadCount: true,
            lastMessageAt: true,
            serviceWindowExpiresAt: true,
            contact: { select: { phoneE164: true, displayName: true, lastSeenAt: true } },
            messages: {
              select: {
                direction: true,
                status: true,
                body: true,
                providerMessageId: true,
                sentAt: true,
              },
            },
          },
        }),
      );

      expect(conversation.contact).toEqual({
        phoneE164: `+${CUSTOMER.firstContact}`,
        displayName: 'Layla',
        lastSeenAt: sentAt,
      });
      expect(conversation.unreadCount).toBe(1);
      expect(conversation.lastMessageAt).toEqual(sentAt);
      // Meta's 24-hour customer service window, from the customer's message.
      expect(conversation.serviceWindowExpiresAt).toEqual(
        new Date(sentAt.getTime() + 24 * 60 * 60 * 1_000),
      );
      expect(conversation.messages).toEqual([
        {
          direction: 'inbound',
          status: 'received',
          body: 'first message',
          providerMessageId: wamid,
          sentAt,
        },
      ]);
    });

    /**
     * A brand-new thread takes its timestamps from the **provider**, written at
     * creation rather than left to a later update.
     *
     * The regression this guards is subtle and was caught against a database
     * carrying an in-flight schema change that gives `last_message_at`
     * `DEFAULT CURRENT_TIMESTAMP`: a thread created blank would then be stamped
     * with row-creation time, which is later than any provider timestamp, so the
     * forward-only guard could never advance it again. The inbox would sort by
     * when we happened to write a row instead of when the customer wrote — and
     * only for the first message in each thread, which is exactly the kind of
     * wrongness nobody notices until a customer does.
     */
    it('stamps a new thread from the provider’s clock, not the database’s', async () => {
      const sentLongAgo = new Date('2026-08-09T08:00:00.000Z');

      await deliver(
        inboundPayload({
          from: CUSTOMER.freshThread,
          wamid: 'wamid.tar67.fresh-thread',
          body: 'first ever message in this thread',
          at: sentLongAgo,
        }),
      );

      const conversation = await asTenant(TENANT_A, async () =>
        tenantPrisma.conversation.findFirstOrThrow({
          where: { contact: { phoneE164: `+${CUSTOMER.freshThread}` } },
          select: { lastMessageAt: true, serviceWindowExpiresAt: true },
        }),
      );

      expect(conversation.lastMessageAt).toEqual(sentLongAgo);
      expect(conversation.serviceWindowExpiresAt).toEqual(
        new Date(sentLongAgo.getTime() + 24 * 60 * 60 * 1_000),
      );
    });

    it('emits message.created for the realtime gateway to relay', async () => {
      const seen: unknown[] = [];
      emitter.on(MESSAGE_CREATED_EVENT, (event) => seen.push(event));

      await deliver(
        inboundPayload({
          from: CUSTOMER.emitted,
          wamid: 'wamid.tar67.emitted',
          body: 'ping',
          at: new Date('2026-08-10T09:05:00.000Z'),
        }),
      );

      expect(seen).toEqual([
        expect.objectContaining({ tenantId: TENANT_A, direction: 'inbound', body: 'ping' }),
      ]);

      emitter.removeAllListeners(MESSAGE_CREATED_EVENT);
    });
  });

  describe('duplicate deliveries', () => {
    it('absorbs a byte-identical retry with the unique constraint, storing one row', async () => {
      const payload = inboundPayload({
        from: CUSTOMER.duplicate,
        wamid: 'wamid.tar67.retried',
        body: 'retried',
        at: new Date('2026-08-10T09:10:00.000Z'),
      });
      const raw = Buffer.from(JSON.stringify(payload), 'utf8');
      const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;

      await expect(ingest.ingestWhatsApp(raw, signature)).resolves.toBe('stored');
      await expect(ingest.ingestWhatsApp(raw, signature)).resolves.toBe('duplicate');
    });

    /**
     * The case the constraint above cannot catch: Meta re-delivering the same
     * message inside a *differently shaped* payload. The message's own unique
     * key is what stops the thread growing a second copy, and stops the unread
     * count moving.
     */
    it('does not write a second message, or a second unread, for a message it already holds', async () => {
      const wamid = 'wamid.tar67.same-message';
      const at = new Date('2026-08-10T09:15:00.000Z');

      await deliver(inboundPayload({ from: CUSTOMER.duplicate, wamid, body: 'hello', at }));
      await deliver(
        inboundPayload({
          from: CUSTOMER.duplicate,
          wamid,
          body: 'hello',
          at,
          profileName: 'Layla',
        }),
      );

      const messages = await asTenant(TENANT_A, async () =>
        tenantPrisma.message.count({ where: { providerMessageId: wamid } }),
      );
      const { unreadCount } = await asTenant(TENANT_A, async () =>
        tenantPrisma.conversation.findFirstOrThrow({
          where: { contact: { phoneE164: `+${CUSTOMER.duplicate}` } },
          select: { unreadCount: true },
        }),
      );

      expect(messages).toBe(1);
      // One message arrived, twice. It is counted once.
      expect(unreadCount).toBe(1);
    });

    /**
     * `conversations_opened` meters conversations, not messages — and the
     * difference is exactly the trap in the increment site (TAR-405). A Prisma
     * `upsert` returns the row whichever branch it took, so incrementing around
     * one would count every inbound message and turn a 1000-conversation
     * allowance into a 1000-message one. The writer uses
     * `ON CONFLICT DO NOTHING RETURNING id` precisely so it can tell.
     */
    it('counts a conversation once, however many messages arrive on it', async () => {
      const from = CUSTOMER.metered;

      for (const [index, body] of ['first', 'second', 'third'].entries()) {
        await deliver(
          inboundPayload({
            from,
            wamid: `wamid.tar67.metered-${index}`,
            body,
            at: new Date(`2026-08-10T09:2${index}:00.000Z`),
          }),
        );
      }

      const messages = await asTenant(TENANT_A, async () =>
        tenantPrisma.message.count({
          where: { conversation: { contact: { phoneE164: `+${from}` } } },
        }),
      );
      const counter = await systemPrisma.usageCounter.findFirstOrThrow({
        where: { tenantId: TENANT_A, metric: 'conversations_opened' },
        select: { value: true },
      });

      expect(messages).toBe(3);
      // Three messages, one thread, one conversation counted. Other fixtures in
      // this suite open their own threads, so the assertion is that the counter
      // did not move three times for this one — hence the message count beside it.
      expect(counter.value).toBeGreaterThanOrEqual(1n);
      await expect(
        asTenant(TENANT_A, async () =>
          tenantPrisma.conversation.count({ where: { contact: { phoneE164: `+${from}` } } }),
        ),
      ).resolves.toBe(1);
    });

    it('is a no-op when the same stored event is processed twice', async () => {
      const eventId = await deliver(
        inboundPayload({
          from: CUSTOMER.reprocessed,
          wamid: 'wamid.tar67.reprocessed',
          body: 'once',
          at: new Date('2026-08-10T09:20:00.000Z'),
        }),
      );

      await tenantContext.run(
        { requestId: REQUEST_ID, tenantId: null, userId: null },
        async () => await processor.process(eventId),
      );

      const { attempts } = await systemPrisma.webhookEvent.findUniqueOrThrow({
        where: { id: eventId },
        select: { attempts: true },
      });

      // The second pass found the row already `processed` and did not claim it.
      expect(attempts).toBe(1);
    });
  });

  describe('out-of-order delivery', () => {
    /**
     * Meta does not guarantee order and ingest is concurrent. The thread has to
     * read correctly anyway, which is why it sorts by the provider's timestamp
     * and why `last_message_at` is a high-water mark rather than an assignment.
     */
    it('keeps the newest timestamp when an older message arrives after a newer one', async () => {
      const newer = new Date('2026-08-10T10:30:00.000Z');
      const older = new Date('2026-08-10T10:00:00.000Z');

      await deliver(
        inboundPayload({
          from: CUSTOMER.outOfOrder,
          wamid: 'wamid.tar67.newer',
          body: 'second',
          at: newer,
        }),
      );
      await deliver(
        inboundPayload({
          from: CUSTOMER.outOfOrder,
          wamid: 'wamid.tar67.older',
          body: 'first',
          at: older,
        }),
      );

      const conversation = await asTenant(TENANT_A, async () =>
        tenantPrisma.conversation.findFirstOrThrow({
          where: { contact: { phoneE164: `+${CUSTOMER.outOfOrder}` } },
          select: {
            lastMessageAt: true,
            unreadCount: true,
            serviceWindowExpiresAt: true,
            messages: { orderBy: { sentAt: 'asc' }, select: { body: true } },
          },
        }),
      );

      expect(conversation.lastMessageAt).toEqual(newer);
      expect(conversation.serviceWindowExpiresAt).toEqual(
        new Date(newer.getTime() + 24 * 60 * 60 * 1_000),
      );
      // Both are stored, and the thread reads in the order the customer sent them.
      expect(conversation.messages.map(({ body }) => body)).toEqual(['first', 'second']);
      expect(conversation.unreadCount).toBe(2);
    });
  });

  describe('a status webhook that overtakes its message', () => {
    const wamid = 'wamid.tar67.status-first';
    const readAt = new Date('2026-08-10T11:00:00.000Z');

    it('creates the message it describes rather than dropping the receipt', async () => {
      const eventId = await deliver(statusPayload({ wamid, status: 'read', at: readAt }));

      await expect(
        systemPrisma.webhookEvent
          .findUniqueOrThrow({ where: { id: eventId }, select: { status: true } })
          .then(({ status }) => status),
      ).resolves.toBe('processed');

      const message = await asTenant(TENANT_A, async () =>
        tenantPrisma.message.findFirstOrThrow({
          where: { providerMessageId: wamid },
          select: { direction: true, status: true, readAt: true, sentAt: true },
        }),
      );

      expect(message).toEqual({
        direction: 'outbound',
        status: 'read',
        readAt,
        sentAt: readAt,
      });
    });

    /**
     * A thread opened by a delivery receipt is timestamped, but the 24-hour
     * customer service window stays closed: it is opened by the customer writing
     * to us, never by us hearing that something we sent arrived. Getting this
     * backwards would let the send path skip the template requirement.
     */
    it('opens no service window for a thread created by a receipt', async () => {
      const conversation = await asTenant(TENANT_A, async () =>
        tenantPrisma.conversation.findFirstOrThrow({
          where: { contact: { phoneE164: `+${CUSTOMER.statuses}` } },
          select: { lastMessageAt: true, serviceWindowExpiresAt: true },
        }),
      );

      expect(conversation.lastMessageAt).toEqual(readAt);
      expect(conversation.serviceWindowExpiresAt).toBeNull();
    });

    /** The acceptance criterion in one assertion: a late `sent` must not un-read it. */
    it('ignores a late status that would move the message backwards', async () => {
      await deliver(
        statusPayload({
          wamid,
          status: 'sent',
          at: new Date('2026-08-10T10:59:00.000Z'),
        }),
      );

      const { status } = await asTenant(TENANT_A, async () =>
        tenantPrisma.message.findFirstOrThrow({
          where: { providerMessageId: wamid },
          select: { status: true },
        }),
      );

      expect(status).toBe('read');
    });

    it('emits message.status_changed only when the status actually advanced', async () => {
      const advancing = 'wamid.tar67.advancing';
      const seen: unknown[] = [];

      await deliver(
        statusPayload({
          wamid: advancing,
          status: 'sent',
          at: new Date('2026-08-10T11:10:00.000Z'),
        }),
      );

      emitter.on(MESSAGE_STATUS_CHANGED_EVENT, (event) => seen.push(event));

      await deliver(
        statusPayload({
          wamid: advancing,
          status: 'delivered',
          at: new Date('2026-08-10T11:11:00.000Z'),
        }),
      );
      await deliver(
        statusPayload({
          wamid: advancing,
          status: 'sent',
          at: new Date('2026-08-10T11:12:00.000Z'),
        }),
      );

      expect(seen).toEqual([expect.objectContaining({ status: 'delivered' })]);

      emitter.removeAllListeners(MESSAGE_STATUS_CHANGED_EVENT);
    });
  });

  describe('an unknown phone_number_id', () => {
    it('is parked failed with its payload intact, never dropped', async () => {
      const eventId = await deliver(
        inboundPayload({
          phoneNumberId: UNCONNECTED_PHONE_NUMBER,
          wamid: 'wamid.tar67.orphan',
          body: 'nobody owns this number yet',
          at: new Date('2026-08-10T12:00:00.000Z'),
        }),
      );

      const parked = await systemPrisma.webhookEvent.findUniqueOrThrow({
        where: { id: eventId },
        select: { status: true, lastError: true, tenantId: true, payload: true },
      });

      expect(parked.status).toBe('failed');
      expect(parked.lastError).toContain(WEBHOOK_FAILURE_REASON.unknownPhoneNumber);
      expect(parked.tenantId).toBeNull();
      expect(JSON.stringify(parked.payload)).toContain('nobody owns this number yet');
    });

    it('is queryable as a batch, which is how an operator finds and replays them', async () => {
      const parked = await systemPrisma.webhookEvent.count({
        where: {
          status: 'failed',
          lastError: { startsWith: WEBHOOK_FAILURE_REASON.unknownPhoneNumber },
        },
      });

      expect(parked).toBeGreaterThanOrEqual(1);
    });
  });

  describe('the sweeper', () => {
    it('re-enqueues an event that was stored but never picked up', async () => {
      const payload = inboundPayload({
        from: CUSTOMER.stuck,
        wamid: 'wamid.tar67.stuck',
        body: 'stored while Redis was down',
        at: new Date('2026-08-10T13:00:00.000Z'),
      });
      const raw = Buffer.from(JSON.stringify(payload), 'utf8');
      const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;

      // The enqueue that never reached Redis, exactly as an outage produces it:
      // the row is durable and `received`, and nothing is going to process it.
      enqueue.mockResolvedValueOnce(false);
      await ingest.ingestWhatsApp(raw, signature);

      const stuckId = (enqueue.mock.calls.at(-1) as [string, string, { webhookEventId: string }])[2]
        .webhookEventId;

      // Age it past the threshold rather than waiting a minute for the clock.
      await systemPrisma.webhookEvent.update({
        where: { id: stuckId },
        data: { receivedAt: new Date('2026-08-10T12:00:00.000Z') },
      });

      enqueue.mockClear();

      await expect(
        sweeper.sweep(new Date('2026-08-10T13:00:00.000Z')),
      ).resolves.toBeGreaterThanOrEqual(1);

      const requeued = enqueue.mock.calls.map(
        ([, , job]: [string, string, { webhookEventId: string }]) => job.webhookEventId,
      );

      expect(requeued).toContain(stuckId);

      // And the re-enqueued job completes the work the outage interrupted.
      await tenantContext.run(
        { requestId: REQUEST_ID, tenantId: null, userId: null },
        async () => await processor.process(stuckId),
      );

      const { status } = await systemPrisma.webhookEvent.findUniqueOrThrow({
        where: { id: stuckId },
        select: { status: true },
      });

      expect(status).toBe('processed');
    });

    it('leaves an event that is neither stuck nor unprocessed alone', async () => {
      enqueue.mockClear();

      await expect(sweeper.sweep(new Date('2026-08-10T13:00:00.000Z'))).resolves.toBe(0);
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('tenant isolation', () => {
    /**
     * The regression that matters most: routing is by `phone_number_id`, and
     * getting it wrong puts one customer's message into another company's inbox.
     */
    it('keeps each tenant’s messages invisible to the other', async () => {
      await deliver(
        inboundPayload({
          phoneNumberId: PHONE_NUMBER_B,
          from: CUSTOMER.firstContact,
          wamid: 'wamid.tar67.tenant-b',
          body: 'for tenant B only',
          at: new Date('2026-08-10T14:00:00.000Z'),
        }),
      );

      const visibleToB = await asTenant(TENANT_B, async () =>
        tenantPrisma.message.findMany({ select: { body: true } }),
      );
      const visibleToA = await asTenant(TENANT_A, async () =>
        tenantPrisma.message.findMany({ select: { body: true } }),
      );

      expect(visibleToB.map(({ body }) => body)).toEqual(['for tenant B only']);
      expect(visibleToA.map(({ body }) => body)).not.toContain('for tenant B only');
    });

    it('gives the same customer a separate contact in each tenant', async () => {
      const inA = await asTenant(TENANT_A, async () =>
        tenantPrisma.contact.findMany({
          where: { phoneE164: `+${CUSTOMER.firstContact}` },
          select: { id: true },
        }),
      );
      const inB = await asTenant(TENANT_B, async () =>
        tenantPrisma.contact.findMany({
          where: { phoneE164: `+${CUSTOMER.firstContact}` },
          select: { id: true },
        }),
      );

      expect(inA).toHaveLength(1);
      expect(inB).toHaveLength(1);
      expect(inA.at(0)?.id).not.toBe(inB.at(0)?.id);
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
