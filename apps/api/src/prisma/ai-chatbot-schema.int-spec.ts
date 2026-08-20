import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * TAR-402: the parts of the AI chatbot schema that `schema.prisma` cannot
 * express, against a real PostgreSQL.
 *
 * The columns, the tables and the ordinary indexes in
 * `20260815150000_ai_chatbot_knowledge_base_and_handoff` are plain Prisma and
 * `migrate diff` reports drift on them loudly. These will not report anything:
 *
 *   1. **`messages_derive_origin`**, the trigger that completes `origin` for
 *      every writer that predates it. Lose it and the CHECK below turns every
 *      agent send in the product into a database error — which is loud, but only
 *      in production. Nothing in the repository's type system or schema tooling
 *      sees a trigger.
 *   2. **`messages_origin_matches_direction`** and the four other CHECKs.
 *      Prisma's schema language has no syntax for one and its describer ignores
 *      them, so a dropped constraint is invisible to every tool here.
 *   3. **The `search_vector` generated column.** Prisma models it as a default it
 *      cannot evaluate. A `migrate dev` that recreated the column as an ordinary
 *      `tsvector` would leave every chunk's vector NULL and every retrieval
 *      empty — which reads as "the knowledge base has no answer", the one
 *      failure this design is built to make impossible to fake.
 *   4. **The two GIN indexes.** Declared in `schema.prisma`, but an operator
 *      class is exactly the kind of detail a regenerated migration drops, and a
 *      trigram index rebuilt without `gin_trgm_ops` silently stops serving the
 *      fallback retriever.
 *   5. **Tenant isolation on the three new tables** — the RLS policies, and the
 *      composite foreign keys that stop a chunk naming another tenant's
 *      document. `pnpm db:verify:rls` proves the first from the catalogue; this
 *      proves both through the client, which is the half a `where` clause could
 *      fake.
 *
 * Each is asserted twice where a behavioural half exists: once on the catalogue
 * definition, so a narrowed predicate is caught by name, and once behaviourally,
 * so a definition that no longer means what it says still fails.
 * `assignment-workload-schema.int-spec.ts` is the worked example this follows.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids and `tar402-fixture` slugs, deleted before the run as well
 * as after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT = '40222222-2222-7222-8222-222222222201';
/**
 * A second, genuinely active tenant. It has to exist rather than be a made-up
 * id: TAR-51's deactivation gate refuses an unknown tenant before RLS is ever
 * consulted, so reading as a fictional one would pass the isolation case
 * without testing isolation.
 */
const OTHER_TENANT = '40222222-2222-7222-8222-222222222202';
const AGENT = '40222222-2222-7222-8222-2222222222a0';
const WABA = '40222222-2222-7222-8222-2222222222b0';
const OTHER_WABA = '40222222-2222-7222-8222-2222222222b1';
const NUMBER = '40222222-2222-7222-8222-2222222222c0';
const OTHER_NUMBER = '40222222-2222-7222-8222-2222222222c1';
const CONTACT = '40222222-2222-7222-8222-2222222222d0';
const OTHER_CONTACT = '40222222-2222-7222-8222-2222222222d1';
const CONVERSATION = '40222222-2222-7222-8222-2222222222e0';
const OTHER_CONVERSATION = '40222222-2222-7222-8222-2222222222e1';
const DOCUMENT = '40222222-2222-7222-8222-2222222222f0';
const OTHER_DOCUMENT = '40222222-2222-7222-8222-2222222222f1';

const REQUEST_ID = 'tar402-int-spec';

/** Asserts a single row and hands it back — `noUncheckedIndexedAccess` is on. */
function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);

  const [row] = rows;

  if (row === undefined) {
    throw new Error('unreachable: the length assertion above would have failed first');
  }

  return row;
}

describe('AI chatbot schema', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

  /** Distinct per message, so a case can be added without renumbering. */
  let nextMessage = 0;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null },
      async () => await work(),
    );
  }

  function indexDefinition(name: string): Promise<{ indexdef: string }[]> {
    return systemPrisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}
    `;
  }

  function checkDefinition(name: string): Promise<{ definition: string }[]> {
    return systemPrisma.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE contype = 'c' AND conname = ${name}
    `;
  }

  function messageId(): string {
    nextMessage += 1;

    return `40222222-2222-7222-8222-4022${String(nextMessage).padStart(8, '0')}`;
  }

  /**
   * Raw and column-listed **without `origin`**, which is the whole point: this is
   * what every message writer in the repository looks like today, and what
   * `WhatsAppInboundWriter` and `MessageSendService` will keep looking like until
   * TAR-406 names the column.
   */
  async function insertLegacyMessage(
    direction: 'inbound' | 'outbound',
    senderUserId: string | null,
  ): Promise<string> {
    const id = messageId();

    await systemPrisma.$executeRaw`
      INSERT INTO messages (id, tenant_id, conversation_id, direction, status, body,
                            sender_user_id, sent_at, updated_at)
      VALUES (${id}::uuid, ${TENANT}::uuid, ${CONVERSATION}::uuid,
              ${direction}::message_direction, 'sent', 'fixture',
              ${senderUserId}::uuid, now(), now())
    `;

    return id;
  }

  async function originOf(id: string): Promise<string> {
    const row = only(
      await systemPrisma.$queryRaw<{ origin: string }[]>`
        SELECT origin::text FROM messages WHERE id = ${id}::uuid
      `,
    );

    return row.origin;
  }

  async function removeFixture(): Promise<void> {
    // Everything below cascades from the tenant, so one delete is enough and
    // stays correct as the schema grows.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT, OTHER_TENANT] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT, slug: 'tar402-fixture', name: 'TAR-402 fixture', status: 'active' },
        { id: OTHER_TENANT, slug: 'tar402-fixture-b', name: 'TAR-402 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.user.create({
      data: {
        id: AGENT,
        tenantId: TENANT,
        email: 'tar402-agent@fixture.test',
        name: 'TAR-402 agent',
        role: 'agent',
        status: 'active',
      },
    });
    await systemPrisma.whatsappBusinessAccount.createMany({
      data: [
        { id: WABA, tenantId: TENANT, wabaId: 'tar402-waba-a' },
        { id: OTHER_WABA, tenantId: OTHER_TENANT, wabaId: 'tar402-waba-b' },
      ],
    });
    await systemPrisma.whatsappAccount.createMany({
      data: [
        {
          id: NUMBER,
          tenantId: TENANT,
          whatsappBusinessAccountId: WABA,
          phoneNumberId: 'tar402-pn-a',
          displayPhoneNumber: '+10000040201',
        },
        {
          id: OTHER_NUMBER,
          tenantId: OTHER_TENANT,
          whatsappBusinessAccountId: OTHER_WABA,
          phoneNumberId: 'tar402-pn-b',
          displayPhoneNumber: '+10000040202',
        },
      ],
    });
    await systemPrisma.contact.createMany({
      data: [
        { id: CONTACT, tenantId: TENANT, phoneE164: '+10000040211' },
        { id: OTHER_CONTACT, tenantId: OTHER_TENANT, phoneE164: '+10000040212' },
      ],
    });
    await systemPrisma.conversation.createMany({
      data: [
        {
          id: CONVERSATION,
          tenantId: TENANT,
          whatsappAccountId: NUMBER,
          contactId: CONTACT,
        },
        {
          id: OTHER_CONVERSATION,
          tenantId: OTHER_TENANT,
          whatsappAccountId: OTHER_NUMBER,
          contactId: OTHER_CONTACT,
        },
      ],
    });
    await systemPrisma.knowledgeDocument.createMany({
      data: [
        {
          id: DOCUMENT,
          tenantId: TENANT,
          title: 'Refunds',
          content: 'You can request a refund within fourteen days of delivery.',
          status: 'indexed',
        },
        {
          id: OTHER_DOCUMENT,
          tenantId: OTHER_TENANT,
          title: 'Other tenant policy',
          content: 'Tenant B keeps its own answers.',
          status: 'indexed',
        },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  describe('`messages.origin` is complete for writers that predate it', () => {
    it('is an exact biconditional against `direction`, by CHECK', async () => {
      const check = only(await checkDefinition('messages_origin_matches_direction'));

      // `contact` is not a degraded value on an outbound row, it is a false
      // statement about who wrote the message — and it is what makes the trigger
      // below sound.
      expect(check.definition).toContain("direction = 'inbound'");
      expect(check.definition).toContain("origin = 'contact'");
    });

    it.each([
      ['inbound', null, 'contact'],
      ['outbound', AGENT, 'agent'],
      ['outbound', null, 'system'],
    ] as const)(
      'classifies a %s message with sender %s as `%s` when the writer does not say',
      async (direction, sender, expected) => {
        expect(await originOf(await insertLegacyMessage(direction, sender))).toBe(expected);
      },
    );

    it('leaves an explicit label alone, which is how TAR-406 records a bot reply', async () => {
      const id = messageId();

      await systemPrisma.$executeRaw`
        INSERT INTO messages (id, tenant_id, conversation_id, direction, status, body,
                              sender_user_id, origin, sent_at, updated_at)
        VALUES (${id}::uuid, ${TENANT}::uuid, ${CONVERSATION}::uuid, 'outbound', 'sent',
                'bot reply', NULL, 'bot', now(), now())
      `;

      // The trigger is a completion, not an override. If it ever became one,
      // every bot reply in the product would be recorded as `system` and TAR-408
      // could not badge it.
      expect(await originOf(id)).toBe('bot');
    });

    it('refuses an inbound message attributed to the bot', async () => {
      const id = messageId();

      await expect(
        systemPrisma.$executeRaw`
          INSERT INTO messages (id, tenant_id, conversation_id, direction, status, body,
                                origin, sent_at, updated_at)
          VALUES (${id}::uuid, ${TENANT}::uuid, ${CONVERSATION}::uuid, 'inbound', 'received',
                  'fixture', 'bot', now(), now())
        `,
      ).rejects.toThrow();
    });

    it('refuses relabelling an outbound message as contact-authored', async () => {
      const id = await insertLegacyMessage('outbound', AGENT);

      // The trigger is INSERT-only, so the CHECK is what guards the invariant
      // afterwards.
      await expect(
        systemPrisma.$executeRaw`UPDATE messages SET origin = 'contact' WHERE id = ${id}::uuid`,
      ).rejects.toThrow();
    });
  });

  describe('the conversation state machine', () => {
    it('starts every conversation at `off` with no engagement time', async () => {
      const conversation = await systemPrisma.conversation.findUniqueOrThrow({
        where: { id: CONVERSATION },
        select: { botState: true, botEngagedAt: true },
      });

      // `off` and `handed_off` are different facts: an empty-knowledge-base
      // tenant's inbox must not look like a tenant whose bot is failing.
      expect(conversation.botState).toBe('off');
      expect(conversation.botEngagedAt).toBeNull();
    });

    it('refuses an engagement time on a conversation the bot never took', async () => {
      const check = only(await checkDefinition('conversations_bot_engaged_at_requires_engagement'));
      expect(check.definition).toContain("bot_state <> 'off'");

      await expect(
        systemPrisma.conversation.update({
          where: { id: CONVERSATION },
          data: { botEngagedAt: new Date() },
        }),
      ).rejects.toThrow();
    });

    it('accepts the pair set together, and clears both on the reset to `off`', async () => {
      await systemPrisma.conversation.update({
        where: { id: CONVERSATION },
        data: { botState: 'bot_active', botEngagedAt: new Date() },
      });

      await systemPrisma.conversation.update({
        where: { id: CONVERSATION },
        data: { botState: 'off', botEngagedAt: null },
      });

      const conversation = await systemPrisma.conversation.findUniqueOrThrow({
        where: { id: CONVERSATION },
        select: { botState: true, botEngagedAt: true },
      });

      expect(conversation.botState).toBe('off');
      expect(conversation.botEngagedAt).toBeNull();
    });
  });

  describe('`knowledge_chunks` retrieval', () => {
    it('generates the search vector from `content` and refuses a direct write', async () => {
      const id = '40222222-2222-7222-8222-402210000001';

      await systemPrisma.$executeRaw`
        INSERT INTO knowledge_chunks (id, tenant_id, document_id, ordinal, content)
        VALUES (${id}::uuid, ${TENANT}::uuid, ${DOCUMENT}::uuid, 0,
                'You can request a refund within fourteen days of delivery.')
      `;

      const row = only(
        await systemPrisma.$queryRaw<{ matches: boolean }[]>`
          SELECT search_vector @@ websearch_to_tsquery('simple', 'refund') AS matches
            FROM knowledge_chunks WHERE id = ${id}::uuid
        `,
      );

      expect(row.matches).toBe(true);

      // A column that could be written is a column that can disagree with the
      // text it is supposed to index — and a chunk whose vector does not match
      // its content is invisible to retrieval, which reads as "the knowledge base
      // has no answer".
      await expect(
        systemPrisma.$executeRaw`UPDATE knowledge_chunks SET search_vector = NULL WHERE id = ${id}::uuid`,
      ).rejects.toThrow();

      await systemPrisma.$executeRaw`DELETE FROM knowledge_chunks WHERE id = ${id}::uuid`;
    });

    it.each([
      ['knowledge_chunks_search_idx', 'gin (search_vector)'],
      ['knowledge_chunks_content_trgm_idx', 'gin (content gin_trgm_ops)'],
    ])('%s is a GIN index over %s', async (name, shape) => {
      const index = only(await indexDefinition(name));

      // Rebuilt without the operator class, the trigram index silently stops
      // serving the fallback retriever and nothing fails.
      expect(index.indexdef.toLowerCase()).toContain(shape);
    });

    it('refuses a chunk pointing at another tenant’s document', async () => {
      // Row-level security stops a tenant *reading* another's rows; only the
      // composite foreign key stops one being *written* against them, which is
      // the path a handler taking a document id from a request body would take.
      await expect(
        systemPrisma.$executeRaw`
          INSERT INTO knowledge_chunks (id, tenant_id, document_id, ordinal, content)
          VALUES (gen_random_uuid(), ${TENANT}::uuid, ${OTHER_DOCUMENT}::uuid, 0, 'leak')
        `,
      ).rejects.toThrow();
    });

    it('refuses two chunks at the same position in one document', async () => {
      const first = '40222222-2222-7222-8222-402210000002';

      await systemPrisma.$executeRaw`
        INSERT INTO knowledge_chunks (id, tenant_id, document_id, ordinal, content)
        VALUES (${first}::uuid, ${TENANT}::uuid, ${DOCUMENT}::uuid, 3, 'first')
      `;

      // Reindex is delete-and-insert in one transaction; this is what stops two
      // indexers producing a half-written chunk set, which is exactly a
      // confidently wrong answer.
      await expect(
        systemPrisma.$executeRaw`
          INSERT INTO knowledge_chunks (id, tenant_id, document_id, ordinal, content)
          VALUES (gen_random_uuid(), ${TENANT}::uuid, ${DOCUMENT}::uuid, 3, 'second')
        `,
      ).rejects.toThrow();

      await systemPrisma.$executeRaw`DELETE FROM knowledge_chunks WHERE id = ${first}::uuid`;
    });
  });

  describe('`bot_turns` is the guard against a double reply', () => {
    it('refuses a second turn for one inbound message', async () => {
      const inbound = await insertLegacyMessage('inbound', null);

      await systemPrisma.botTurn.create({
        data: {
          tenantId: TENANT,
          conversationId: CONVERSATION,
          inboundMessageId: inbound,
          outcome: 'replied',
        },
      });

      // A deterministic BullMQ job id de-duplicates a re-enqueue. It does not
      // de-duplicate a worker that crashed after the send and before the ack, and
      // a second WhatsApp message to a customer is unrecoverable.
      await expect(
        systemPrisma.botTurn.create({
          data: {
            tenantId: TENANT,
            conversationId: CONVERSATION,
            inboundMessageId: inbound,
            outcome: 'replied',
          },
        }),
      ).rejects.toThrow();
    });

    it('ties `handoff_reason` to the handed-off outcome in both directions', async () => {
      const check = only(await checkDefinition('bot_turns_handoff_reason_matches_outcome'));
      expect(check.definition).toContain("outcome = 'handed_off'");

      await expect(
        systemPrisma.botTurn.create({
          data: {
            tenantId: TENANT,
            conversationId: CONVERSATION,
            inboundMessageId: await insertLegacyMessage('inbound', null),
            outcome: 'replied',
            handoffReason: 'low_confidence',
          },
        }),
      ).rejects.toThrow();

      await expect(
        systemPrisma.botTurn.create({
          data: {
            tenantId: TENANT,
            conversationId: CONVERSATION,
            inboundMessageId: await insertLegacyMessage('inbound', null),
            outcome: 'handed_off',
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a score outside 0..1', async () => {
      // The threshold an admin sets is compared against these. A score of 1.5
      // would pass any threshold, which is the failure in the dangerous
      // direction — a confidently wrong answer reaching a customer.
      await expect(
        systemPrisma.botTurn.create({
          data: {
            tenantId: TENANT,
            conversationId: CONVERSATION,
            inboundMessageId: await insertLegacyMessage('inbound', null),
            outcome: 'replied',
            score: 1.5,
          },
        }),
      ).rejects.toThrow();
    });

    it('accepts the shape a real turn writes, including a partial score set', async () => {
      const inbound = await insertLegacyMessage('inbound', null);

      // `no_match`: retrieval ran and found nothing above the floor, so the model
      // was never called and there is no model confidence to record. The three
      // score columns are bounded individually for exactly this reason.
      const turn = await systemPrisma.botTurn.create({
        data: {
          tenantId: TENANT,
          conversationId: CONVERSATION,
          inboundMessageId: inbound,
          outcome: 'handed_off',
          handoffReason: 'no_match',
          retrievalScore: 0,
          citedChunkIds: [],
        },
        select: { id: true, modelConfidence: true, citedChunkIds: true },
      });

      expect(turn.modelConfidence).toBeNull();
      expect(turn.citedChunkIds).toEqual([]);
    });

    it('accepts a scored turn that ends as a suppression, with no handoff reason', async () => {
      // The shape `BotTurnService.suppressUnanswered` writes when the bot could
      // not answer and had never spoken: the claim is corrected from
      // `handed_off`/`bot_error` to `suppressed`, and the reason **must** go with
      // it, because the check is a biconditional. The scores stay, which is what
      // still shows the model was called.
      //
      // Proved here rather than against a mock: a unit test that stubs Prisma
      // cannot fail on a constraint, and this is the path that must never throw.
      const turn = await systemPrisma.botTurn.create({
        data: {
          tenantId: TENANT,
          conversationId: CONVERSATION,
          inboundMessageId: await insertLegacyMessage('inbound', null),
          outcome: 'suppressed',
          handoffReason: null,
          error: 'no_answer_unengaged',
          score: 0.3,
          modelConfidence: 0.3,
          retrievalScore: 1,
        },
        select: { id: true, handoffReason: true, error: true },
      });

      expect(turn).toMatchObject({ handoffReason: null, error: 'no_answer_unengaged' });

      await expect(
        systemPrisma.botTurn.create({
          data: {
            tenantId: TENANT,
            conversationId: CONVERSATION,
            inboundMessageId: await insertLegacyMessage('inbound', null),
            outcome: 'suppressed',
            handoffReason: 'low_confidence',
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('`handoff_events`', () => {
    it('records more than one handoff per conversation', async () => {
      // A conversation can be resolved, reopened by a later question, handled by
      // the bot again and handed off again. A unique constraint here would make
      // the second one fail.
      for (const reason of ['no_match', 'customer_requested'] as const) {
        await systemPrisma.handoffEvent.create({
          data: {
            tenantId: TENANT,
            conversationId: CONVERSATION,
            reason,
            triggerMessageId: await insertLegacyMessage('inbound', null),
            botReplyCount: 0,
          },
        });
      }

      const events = await systemPrisma.handoffEvent.findMany({
        where: { conversationId: CONVERSATION },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { reason: true },
      });

      expect(events.length).toBeGreaterThanOrEqual(2);
    });

    it('refuses replies with no time at which they started', async () => {
      // `botEngagedAt` is the start of the window the handoff DTO's `botExchange`
      // spans. A handoff reporting replies without one hands the agent an
      // unbounded window.
      await expect(
        systemPrisma.handoffEvent.create({
          data: {
            tenantId: TENANT,
            conversationId: CONVERSATION,
            reason: 'low_confidence',
            triggerMessageId: await insertLegacyMessage('inbound', null),
            botReplyCount: 2,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('`ai_configs` bounds the gate reads', () => {
    it('defaults a tenant to the published threshold and turn cap', async () => {
      const config = await systemPrisma.aiConfig.create({
        data: { tenantId: TENANT },
        select: { minConfidence: true, maxBotTurns: true, handoffMessage: true, isEnabled: true },
      });

      expect(config.minConfidence.toString()).toBe('0.6');
      expect(config.maxBotTurns).toBe(5);
      // Opt-in: a tenant that hands off on every unmatched greeting would
      // otherwise spam the customer.
      expect(config.handoffMessage).toBeNull();
      expect(config.isEnabled).toBe(false);
    });

    it.each([
      ['min_confidence above 1', { minConfidence: 1.5 }],
      ['min_confidence below 0', { minConfidence: -0.1 }],
      ['max_bot_turns of 0', { maxBotTurns: 0 }],
      ['max_bot_turns above 20', { maxBotTurns: 21 }],
    ])('refuses %s', async (_label, data) => {
      await expect(
        systemPrisma.aiConfig.update({ where: { tenantId: TENANT }, data }),
      ).rejects.toThrow();
    });
  });

  describe('tenant isolation on the three new tables', () => {
    it('shows a tenant its own rows and none of the other tenant’s', async () => {
      const inbound = await insertLegacyMessage('inbound', null);

      await systemPrisma.botTurn.create({
        data: {
          tenantId: TENANT,
          conversationId: CONVERSATION,
          inboundMessageId: inbound,
          outcome: 'suppressed',
        },
      });

      // No `where` on `tenantId` anywhere below. RLS is what filters, which is
      // the guarantee — a `where` clause is a thing somebody has to remember.
      const mine = await asTenant(TENANT, () => tenantPrisma.botTurn.findMany());
      const theirs = await asTenant(OTHER_TENANT, () => tenantPrisma.botTurn.findMany());

      expect(mine.length).toBeGreaterThan(0);
      expect(theirs).toHaveLength(0);
    });

    it('refuses a cross-tenant write through the tenant client', async () => {
      // The policy's `WITH CHECK` half. A handler taking `tenantId` from a
      // request body cannot write into another tenant.
      await expect(
        asTenant(OTHER_TENANT, () =>
          tenantPrisma.handoffEvent.create({
            data: {
              tenantId: TENANT,
              conversationId: CONVERSATION,
              reason: 'agent_requested',
              triggerMessageId: messageId(),
              botReplyCount: 0,
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('cannot retrieve another tenant’s chunk, which is the prompt-leak path', async () => {
      const id = '40222222-2222-7222-8222-402210000003';

      await systemPrisma.$executeRaw`
        INSERT INTO knowledge_chunks (id, tenant_id, document_id, ordinal, content)
        VALUES (${id}::uuid, ${OTHER_TENANT}::uuid, ${OTHER_DOCUMENT}::uuid, 0,
                'zzdistinctivestringzz that must never reach tenant A')
      `;

      // The risk unique to this story is the prompt rather than the query: a
      // prompt assembled with another tenant's chunks leaks content no `where`
      // clause could recover. This is the first of the two guards; asserting the
      // cited-id check is the second and belongs to TAR-406.
      const found = await asTenant(TENANT, () =>
        tenantPrisma.knowledgeChunk.findMany({
          where: { content: { contains: 'zzdistinctivestringzz' } },
        }),
      );

      expect(found).toHaveLength(0);

      await systemPrisma.$executeRaw`DELETE FROM knowledge_chunks WHERE id = ${id}::uuid`;
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
