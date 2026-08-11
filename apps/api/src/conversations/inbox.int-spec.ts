import { EventEmitter2 } from '@nestjs/event-emitter';
import { permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import {
  IdempotencyKeyReusedError,
  IdempotentRequestInFlightError,
} from '../common/idempotency/idempotency.errors';
import { ResponseOriginService } from '../common/response-origin.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import type { MediaSendResolver } from '../media/media-send.resolver';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import type { QueueService } from '../queue/queue.service';
import { MessageTemplateQueryService } from '../whatsapp/message-template-query.service';
import { ConversationQueryService } from './conversation-query.service';
import { ConversationCommandService } from './conversation-command.service';
import { ConversationNotFoundError, ServiceWindowExpiredError } from './conversations.errors';
import { MessageSendService } from './message-send.service';

/**
 * TAR-68's acceptance criteria against a real PostgreSQL with TAR-48's policies
 * applied, running as `whatsappcrm_app` — the role holding no `BYPASSRLS`.
 *
 * A unit test can show that the send service checks a column. Only this can show
 * that the isolation is real: that `conversations`, `messages` and
 * `idempotency_keys` actually carry the `tenant_isolation` policy, that the
 * shared-inbox widening does not reach across a tenant boundary, and that the
 * unique index on `(tenant_id, key)` is what stops a double-click sending two
 * messages.
 *
 * Four criteria are covered here, and each one names the row it turns on:
 *
 *   * free-form send inside the 24-hour window, refused outside it, and an
 *     approved template accepted outside it;
 *   * `Idempotency-Key` replay — same body replays, different body is 409;
 *   * an unclaimed conversation is visible to every agent on the tenant, and
 *     stops being once it is claimed;
 *   * tenant A cannot see, send to, or replay a key into tenant B.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Two fixture
 * tenants with fixed ids and a `tar68-fixture` marker, deleted before the run as
 * well as after it, so an interrupted run cleans up on the next one. Point
 * `pnpm test:db` at a local or disposable database.
 *
 * Prerequisites — the four commands in the README:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '68444444-4444-7444-8444-444444444401';
const TENANT_B = '68444444-4444-7444-8444-444444444402';

const WABA_A = '68444444-4444-7444-8444-4444444444b0';
const NUMBER_A = '68444444-4444-7444-8444-4444444444a0';
const WABA_B = '68444444-4444-7444-8444-4444444444b9';
const NUMBER_B = '68444444-4444-7444-8444-4444444444a9';

const AGENT_A = '68444444-4444-7444-8444-4444444444d1';
const OTHER_AGENT_A = '68444444-4444-7444-8444-4444444444d2';
const AGENT_B = '68444444-4444-7444-8444-4444444444d9';

const CONTACT_A = '68444444-4444-7444-8444-4444444444c1';
const CONTACT_B = '68444444-4444-7444-8444-4444444444c9';

const OPEN_THREAD = '68444444-4444-7444-8444-4444444444f1';
const CLOSED_THREAD = '68444444-4444-7444-8444-4444444444f2';
const TENANT_B_THREAD = '68444444-4444-7444-8444-4444444444f9';

const REQUEST_ID = 'tar68-int-spec';
const FIXTURE_PREFIX = 'tar68-fixture';

const HOUR_MS = 60 * 60 * 1_000;

function principalFor(
  tenantId: string,
  userId: string,
  role: 'agent' | 'supervisor',
): SessionPrincipal {
  return {
    userId,
    tenantId,
    email: `${userId}@example.invalid`,
    displayName: 'Fixture agent',
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [],
    sessionId: userId,
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

describe('the shared inbox, end to end', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let conversations: ConversationQueryService;
  let commands: ConversationCommandService;
  let sends: MessageSendService;
  let idempotency: IdempotencyService;
  let enqueued: unknown[];

  function as<T>(principal: SessionPrincipal, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      {
        requestId: REQUEST_ID,
        tenantId: principal.tenantId,
        userId: principal.userId,
        principal,
        hostname: 'acme.example',
      },
      async () => await work(),
    );
  }

  /** A fresh key per call, so one test cannot replay another's. */
  function key(suffix: string): string {
    return `68444444-4444-7444-8444-4444444${suffix}`;
  }

  function sendText(principal: SessionPrincipal, conversationId: string, body: string) {
    return as(principal, async () => await sends.send(conversationId, { type: 'text', body }));
  }

  async function removeFixture(): Promise<void> {
    // Everything below cascades from `tenants`.
    await systemPrisma.tenant.deleteMany({ where: { slug: { startsWith: FIXTURE_PREFIX } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    enqueued = [];

    const queue = {
      enqueue: (_queue: string, _job: string, data: unknown) => {
        enqueued.push(data);

        return Promise.resolve('added' as const);
      },
    } as unknown as QueueService;

    conversations = new ConversationQueryService(tenantPrisma, tenantContext);
    commands = new ConversationCommandService(tenantPrisma, conversations);
    idempotency = new IdempotencyService(tenantPrisma, tenantContext);
    sends = new MessageSendService(
      tenantPrisma,
      tenantContext,
      conversations,
      new MessageTemplateQueryService(tenantPrisma),
      // No media in this fixture; a call would be a test defect rather than a
      // path worth stubbing plausibly.
      {
        describeForSend: () => {
          throw new Error('no media in this fixture');
        },
      } as unknown as MediaSendResolver,
      queue,
      new EventEmitter2(),
      new ResponseOriginService({ getOrThrow: () => 'https' } as never, tenantContext),
    );

    await removeFixture();
    await seedFixture(systemPrisma);
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(() => {
    enqueued = [];
  });

  describe('the 24-hour service window', () => {
    it('accepts a free-form message inside the window', async () => {
      const message = await sendText(
        principalFor(TENANT_A, AGENT_A, 'agent'),
        OPEN_THREAD,
        'On its way.',
      );

      expect(message).toMatchObject({ status: 'queued', direction: 'outbound', type: 'text' });
      // Queued, not sent inline: the row is the durable statement of intent and
      // the worker is only how it gets acted on.
      expect(enqueued).toHaveLength(1);
    });

    it('refuses a free-form message once the window has closed', async () => {
      await expect(
        sendText(principalFor(TENANT_A, AGENT_A, 'agent'), CLOSED_THREAD, 'Still there?'),
      ).rejects.toBeInstanceOf(ServiceWindowExpiredError);
    });

    it('writes no message row when it refuses', async () => {
      // The refusal has to happen before anything is written, or an agent sees a
      // reply in the thread that the customer never receives.
      const messages = await as(
        principalFor(TENANT_A, AGENT_A, 'agent'),
        async () => await tenantPrisma.message.count({ where: { conversationId: CLOSED_THREAD } }),
      );

      expect(messages).toBe(0);
      expect(enqueued).toHaveLength(0);
    });

    it('accepts an approved template once the window has closed', async () => {
      const message = await as(
        principalFor(TENANT_A, AGENT_A, 'agent'),
        async () =>
          await sends.send(CLOSED_THREAD, {
            type: 'template',
            templateName: 'order_shipped',
            languageCode: 'en_US',
            variables: ['Maria'],
          }),
      );

      expect(message).toMatchObject({ status: 'queued', type: 'template' });
      // The approved body, rendered locally so the thread is readable.
      expect(message.body).toBe('Hi Maria, your order has shipped.');
    });

    it('refuses a template that is not approved on this number', async () => {
      await expect(
        as(
          principalFor(TENANT_A, AGENT_A, 'agent'),
          async () =>
            await sends.send(CLOSED_THREAD, {
              type: 'template',
              templateName: 'awaiting_review',
              languageCode: 'en_US',
              variables: [],
            }),
        ),
      ).rejects.toThrow(/No approved template/);
    });
  });

  describe('Idempotency-Key', () => {
    const body = { type: 'text', body: 'Sent once.' } as const;

    function send(agentKey: string) {
      const principal = principalFor(TENANT_A, AGENT_A, 'agent');

      return as(
        principal,
        async () =>
          await idempotency.execute(
            {
              key: agentKey,
              operation: 'conversation.send',
              target: OPEN_THREAD,
              payload: body,
              statusCode: 201,
            },
            async () => await sends.send(OPEN_THREAD, body),
          ),
      );
    }

    it('replays the stored response and sends nothing a second time', async () => {
      const first = await send(key('44444a1'));
      const replay = await send(key('44444a1'));

      expect(replay.replayed).toBe(true);
      expect(replay.body).toEqual(first.body);
      // One queued delivery for two requests. This is the requirement.
      expect(enqueued).toHaveLength(1);
    });

    it('refuses the same key with a different body', async () => {
      const reusedKey = key('44444a2');
      const principal = principalFor(TENANT_A, AGENT_A, 'agent');

      await send(reusedKey);

      await expect(
        as(
          principal,
          async () =>
            await idempotency.execute(
              {
                key: reusedKey,
                operation: 'conversation.send',
                target: OPEN_THREAD,
                payload: { type: 'text', body: 'A different message.' },
                statusCode: 201,
              },
              async () =>
                await sends.send(OPEN_THREAD, { type: 'text', body: 'A different message.' }),
            ),
        ),
      ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    });

    it('lets two tenants use the same key independently', async () => {
      // `(tenant_id, key)` is the unique index, and RLS is what makes the lookup
      // tenant-scoped. A global key space would have one tenant replaying the
      // other's response.
      const shared = key('44444a3');

      await send(shared);

      const other = await as(
        principalFor(TENANT_B, AGENT_B, 'supervisor'),
        async () =>
          await idempotency.execute(
            {
              key: shared,
              operation: 'conversation.send',
              target: TENANT_B_THREAD,
              payload: body,
              statusCode: 201,
            },
            async () => await sends.send(TENANT_B_THREAD, body),
          ),
      );

      expect(other.replayed).toBe(false);
    });

    it('reports a key whose first attempt is still running', async () => {
      const inFlight = key('44444a4');
      const principal = principalFor(TENANT_A, AGENT_A, 'agent');
      let release: () => void = () => undefined;

      const first = as(
        principal,
        async () =>
          await idempotency.execute(
            {
              key: inFlight,
              operation: 'conversation.send',
              target: OPEN_THREAD,
              payload: body,
              statusCode: 201,
            },
            async () => {
              await new Promise<void>((resolve) => {
                release = resolve;
              });

              return await sends.send(OPEN_THREAD, body);
            },
          ),
      );

      // Let the claim land before the retry arrives.
      await new Promise((resolve) => setTimeout(resolve, 50));

      await expect(
        as(
          principal,
          async () =>
            await idempotency.execute(
              {
                key: inFlight,
                operation: 'conversation.send',
                target: OPEN_THREAD,
                payload: body,
                statusCode: 201,
              },
              async () => await sends.send(OPEN_THREAD, body),
            ),
        ),
      ).rejects.toBeInstanceOf(IdempotentRequestInFlightError);

      release();
      await first;
    });
  });

  describe('shared-inbox visibility', () => {
    it('shows an unclaimed conversation to every agent on the tenant', async () => {
      // The acceptance criterion: a customer writes in, and the thread is
      // reachable by whichever agent is free — not invisible until a supervisor
      // routes it.
      const page = await as(
        principalFor(TENANT_A, OTHER_AGENT_A, 'agent'),
        async () =>
          await conversations.list({ limit: 25, scope: 'unassigned', status: 'open' as const }),
      );

      expect(page.items.map((item) => item.id)).toContain(OPEN_THREAD);
    });

    it('lets that agent open the unclaimed thread', async () => {
      await expect(
        as(
          principalFor(TENANT_A, OTHER_AGENT_A, 'agent'),
          async () => await conversations.get(OPEN_THREAD),
        ),
      ).resolves.toMatchObject({ id: OPEN_THREAD });
    });

    it('hides it from the pool once it is claimed, and from the agent who is not on it', async () => {
      await as(
        principalFor(TENANT_A, AGENT_A, 'supervisor'),
        async () => await commands.assign(CLOSED_THREAD, { userId: AGENT_A }),
      );

      const page = await as(
        principalFor(TENANT_A, OTHER_AGENT_A, 'agent'),
        async () => await conversations.list({ limit: 25, scope: 'unassigned' }),
      );

      expect(page.items.map((item) => item.id)).not.toContain(CLOSED_THREAD);
      await expect(
        as(
          principalFor(TENANT_A, OTHER_AGENT_A, 'agent'),
          async () => await conversations.get(CLOSED_THREAD),
        ),
      ).rejects.toBeInstanceOf(ConversationNotFoundError);
    });

    it('still shows it to the agent who holds it', async () => {
      const page = await as(
        principalFor(TENANT_A, AGENT_A, 'agent'),
        async () => await conversations.list({ limit: 25, scope: 'assigned' }),
      );

      expect(page.items.map((item) => item.id)).toContain(CLOSED_THREAD);
    });
  });

  describe('tenant isolation', () => {
    it('never lists another tenant conversation, at any scope', async () => {
      const page = await as(
        principalFor(TENANT_A, AGENT_A, 'supervisor'),
        async () => await conversations.list({ limit: 100, scope: 'all' }),
      );

      expect(page.items.map((item) => item.id)).not.toContain(TENANT_B_THREAD);
    });

    it('answers not_found — not forbidden — for another tenant conversation', async () => {
      await expect(
        as(
          principalFor(TENANT_A, AGENT_A, 'supervisor'),
          async () => await conversations.get(TENANT_B_THREAD),
        ),
      ).rejects.toBeInstanceOf(ConversationNotFoundError);
    });

    it('refuses to send into another tenant thread', async () => {
      await expect(
        sendText(principalFor(TENANT_A, AGENT_A, 'supervisor'), TENANT_B_THREAD, 'Wrong tenant.'),
      ).rejects.toBeInstanceOf(ConversationNotFoundError);
      expect(enqueued).toHaveLength(0);
    });
  });

  describe('keyset pagination', () => {
    it('reaches every conversation exactly once, one row at a time', async () => {
      const principal = principalFor(TENANT_A, AGENT_A, 'supervisor');
      const seen: string[] = [];
      let cursor: string | undefined;

      for (let request = 0; request < 10; request += 1) {
        const page = await as(
          principal,
          async () => await conversations.list({ limit: 1, scope: 'all', cursor }),
        );

        seen.push(...page.items.map((item) => item.id));

        if (page.nextCursor === null) {
          break;
        }

        cursor = page.nextCursor;
      }

      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expect.arrayContaining([OPEN_THREAD, CLOSED_THREAD]));
    });

    it('rejects a cursor it did not issue', async () => {
      await expect(
        as(
          principalFor(TENANT_A, AGENT_A, 'supervisor'),
          async () => await conversations.list({ limit: 25, scope: 'all', cursor: 'not-a-cursor' }),
        ),
      ).rejects.toThrow(/cursor is not valid/);
    });
  });
});

/**
 * Two tenants, each with a number, a contact and a thread. Tenant A gets two
 * threads: one inside the service window and one outside it, which is the pair
 * the window criterion turns on.
 *
 * Written through `SystemPrisma` because the fixture spans tenants, which is
 * exactly what `TenantPrisma` refuses — and refusing it is the property the
 * isolation tests above are asserting.
 */
async function seedFixture(systemPrisma: PrismaClient): Promise<void> {
  const now = Date.now();

  await systemPrisma.tenant.createMany({
    data: [
      { id: TENANT_A, slug: `${FIXTURE_PREFIX}-a`, name: 'TAR-68 tenant A', status: 'active' },
      { id: TENANT_B, slug: `${FIXTURE_PREFIX}-b`, name: 'TAR-68 tenant B', status: 'active' },
    ],
  });

  await systemPrisma.user.createMany({
    data: [
      {
        id: AGENT_A,
        tenantId: TENANT_A,
        email: 'a1@tar68.invalid',
        name: 'A1',
        role: 'supervisor',
        status: 'active',
      },
      {
        id: OTHER_AGENT_A,
        tenantId: TENANT_A,
        email: 'a2@tar68.invalid',
        name: 'A2',
        role: 'agent',
        status: 'active',
      },
      {
        id: AGENT_B,
        tenantId: TENANT_B,
        email: 'b1@tar68.invalid',
        name: 'B1',
        role: 'supervisor',
        status: 'active',
      },
    ],
  });

  await systemPrisma.whatsappBusinessAccount.createMany({
    data: [
      { id: WABA_A, tenantId: TENANT_A, wabaId: `${FIXTURE_PREFIX}-waba-a` },
      { id: WABA_B, tenantId: TENANT_B, wabaId: `${FIXTURE_PREFIX}-waba-b` },
    ],
  });

  await systemPrisma.whatsappAccount.createMany({
    data: [
      {
        id: NUMBER_A,
        tenantId: TENANT_A,
        whatsappBusinessAccountId: WABA_A,
        phoneNumberId: `${FIXTURE_PREFIX}-number-a`,
        displayPhoneNumber: '+10000006801',
      },
      {
        id: NUMBER_B,
        tenantId: TENANT_B,
        whatsappBusinessAccountId: WABA_B,
        phoneNumberId: `${FIXTURE_PREFIX}-number-b`,
        displayPhoneNumber: '+10000006802',
      },
    ],
  });

  await systemPrisma.messageTemplate.createMany({
    data: [
      {
        tenantId: TENANT_A,
        whatsappBusinessAccountId: WABA_A,
        name: 'order_shipped',
        language: 'en_US',
        status: 'approved',
        components: [{ type: 'BODY', text: 'Hi {{1}}, your order has shipped.' }],
      },
      {
        // Approved by nobody yet: the template the send path must refuse.
        tenantId: TENANT_A,
        whatsappBusinessAccountId: WABA_A,
        name: 'awaiting_review',
        language: 'en_US',
        status: 'pending',
        components: [{ type: 'BODY', text: 'Anything at all.' }],
      },
    ],
  });

  await systemPrisma.contact.createMany({
    data: [
      { id: CONTACT_A, tenantId: TENANT_A, phoneE164: '+966500006801', displayName: 'Maria' },
      {
        id: '68444444-4444-7444-8444-4444444444c2',
        tenantId: TENANT_A,
        phoneE164: '+966500006802',
        displayName: 'Omar',
      },
      { id: CONTACT_B, tenantId: TENANT_B, phoneE164: '+966500006809', displayName: 'Neighbour' },
    ],
  });

  await systemPrisma.conversation.createMany({
    data: [
      {
        id: OPEN_THREAD,
        tenantId: TENANT_A,
        whatsappAccountId: NUMBER_A,
        contactId: CONTACT_A,
        status: 'open',
        lastMessageAt: new Date(now - HOUR_MS),
        // Opened an hour ago and good for another 23.
        serviceWindowExpiresAt: new Date(now + 23 * HOUR_MS),
      },
      {
        id: CLOSED_THREAD,
        tenantId: TENANT_A,
        whatsappAccountId: NUMBER_A,
        contactId: '68444444-4444-7444-8444-4444444444c2',
        status: 'open',
        lastMessageAt: new Date(now - 30 * HOUR_MS),
        serviceWindowExpiresAt: new Date(now - 6 * HOUR_MS),
      },
      {
        id: TENANT_B_THREAD,
        tenantId: TENANT_B,
        whatsappAccountId: NUMBER_B,
        contactId: CONTACT_B,
        status: 'open',
        lastMessageAt: new Date(now - HOUR_MS),
        serviceWindowExpiresAt: new Date(now + 23 * HOUR_MS),
      },
    ],
  });
}

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
