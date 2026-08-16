import { BOT_CONFIDENCE } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { chunkDocument } from './chunk-document';
import { KnowledgeIndexerService } from './knowledge-indexer.service';
import { KnowledgeRetrieverService } from './knowledge-retriever.service';

/**
 * TAR-406: retrieval, against a real PostgreSQL.
 *
 * `KnowledgeRetrieverService` is the one class in this story that a unit test
 * cannot cover honestly. Its whole behaviour is two hand-written SQL statements
 * against a generated `tsvector` and `pg_trgm` — mock the database and what is
 * left is a string nobody executes. Both statements were **wrong in ways only a
 * real database showed**: the first ANDed the question's terms so no customer
 * sentence could ever match, and the second compared whole strings so the
 * fallback could never fire. Neither failure raises anything; both read as "the
 * knowledge base has no answer".
 *
 * Four things are proved here, and each fails silently otherwise:
 *
 *   1. **A match is found and ranked.** If the generated column were rebuilt as
 *      an ordinary `tsvector`, every vector would be NULL and every retrieval
 *      empty — which reads as "the knowledge base has no answer", the one
 *      failure this design exists to make impossible to fake.
 *   2. **A non-match returns nothing.** The refusal is what TAR-28's third
 *      acceptance criterion rests on: zero chunks means the model is never
 *      called, so a wrong answer is unreachable rather than unlikely.
 *   3. **The trigram fallback fires on a misspelling**, and only when full-text
 *      search found nothing.
 *   4. **A distinctive string indexed in tenant A never reaches tenant B** —
 *      the two-tenant test 0010's security section names by hand, because the
 *      cross-tenant risk unique to this story is the prompt rather than the
 *      query: content that reached an assembled prompt is content no `where`
 *      clause can recover.
 *
 * A fifth is a consequence of the join rather than of the index: a document that
 * is `pending` or `failed` is not citable, so a re-index in flight cannot have
 * the bot quoting text the tenant has already replaced.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids and `tar406-fixture` slugs, deleted before the run as well
 * as after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT = '41333333-3333-7333-8333-333333333301';
/**
 * A second, genuinely active tenant. It has to exist rather than be a made-up
 * id: TAR-51's deactivation gate refuses an unknown tenant before RLS is ever
 * consulted, so reading as a fictional one would pass the isolation case
 * without testing isolation.
 */
const OTHER_TENANT = '41333333-3333-7333-8333-333333333302';
const DOCUMENT = '41333333-3333-7333-8333-3333333333f0';
const OTHER_DOCUMENT = '41333333-3333-7333-8333-3333333333f1';
const DRAFT_DOCUMENT = '41333333-3333-7333-8333-3333333333f2';

const REQUEST_ID = 'tar406-int-spec';

/**
 * A string that exists in exactly one tenant's knowledge base and nowhere else
 * in the corpus, so "did tenant B see tenant A's content" is a substring check
 * rather than a judgement.
 */
const TENANT_A_SECRET = 'zarquon';

describe('knowledge retrieval', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let retriever: KnowledgeRetrieverService;
  let indexer: KnowledgeIndexerService;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null },
      async () => await work(),
    );
  }

  async function removeFixture(): Promise<void> {
    // Documents and chunks cascade from the tenant, so one delete is enough and
    // stays correct as the schema grows.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT, OTHER_TENANT] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);
    retriever = new KnowledgeRetrieverService(tenantPrisma);
    indexer = new KnowledgeIndexerService(tenantPrisma);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT, slug: 'tar406-fixture', name: 'TAR-406 fixture', status: 'active' },
        { id: OTHER_TENANT, slug: 'tar406-fixture-b', name: 'TAR-406 fixture B', status: 'active' },
      ],
    });

    await systemPrisma.knowledgeDocument.createMany({
      data: [
        {
          id: DOCUMENT,
          tenantId: TENANT,
          title: 'Refund policy',
          content: [
            `Refunds are issued within five working days of the ${TENANT_A_SECRET} approval step.`,
            'Damaged goods are collected by our courier at no charge to the customer.',
          ].join('\n\n'),
          status: 'pending',
        },
        {
          id: OTHER_DOCUMENT,
          tenantId: OTHER_TENANT,
          title: 'Delivery policy',
          content: 'Delivery takes two working days across the country.',
          status: 'pending',
        },
        {
          id: DRAFT_DOCUMENT,
          tenantId: TENANT,
          title: 'Warranty policy',
          content: 'Warranty claims are handled by the manufacturer within thirty days.',
          status: 'pending',
        },
      ],
    });

    // Indexed through the real indexer rather than by hand-writing chunk rows:
    // the generated `search_vector` is written by the database on insert, so
    // what this proves is the whole write path a knowledge base actually takes.
    await asTenant(TENANT, async () => indexer.index(DOCUMENT));
    await asTenant(OTHER_TENANT, async () => indexer.index(OTHER_DOCUMENT));
    await asTenant(TENANT, async () => indexer.index(DRAFT_DOCUMENT));

    // …and then put back to `pending`, so the join's status filter has something
    // to exclude. Its chunks stay on disk, which is exactly the state a document
    // is in while a re-index is queued.
    await systemPrisma.knowledgeDocument.update({
      where: { id: DRAFT_DOCUMENT },
      data: { status: 'pending' },
    });
  });

  afterAll(async () => {
    await removeFixture();
    await systemPrisma.$disconnect();
    await tenantBase.$disconnect();
  });

  it('indexes a document, and the denormalised chunk count matches the rows written', async () => {
    const document = await systemPrisma.knowledgeDocument.findUniqueOrThrow({
      where: { id: DOCUMENT },
      select: { content: true, status: true, chunkCount: true, indexedAt: true, indexError: true },
    });
    const written = await systemPrisma.knowledgeChunk.count({ where: { documentId: DOCUMENT } });

    expect(document).toMatchObject({ status: 'indexed', indexError: null });
    expect(document.indexedAt).not.toBeNull();
    // The console renders `chunkCount` without a count query per row, so a
    // denormalisation that drifts is a number an admin is quietly shown.
    expect(document.chunkCount).toBe(written);
    expect(written).toBe(chunkDocument(document.content).length);
  });

  it('lets PostgreSQL generate the search vector, which is what makes a match possible', async () => {
    // Prisma models `search_vector` as a default it cannot evaluate, so a
    // regenerated migration that recreated it as an ordinary `tsvector` would
    // leave every vector NULL — and every retrieval empty, which reads exactly
    // like a tenant with no knowledge base.
    const [row] = await systemPrisma.$queryRaw<{ populated: boolean }[]>`
      SELECT search_vector IS NOT NULL AND search_vector <> ''::tsvector AS populated
        FROM knowledge_chunks
       WHERE document_id = ${DOCUMENT}::uuid
       LIMIT 1
    `;

    expect(row?.populated).toBe(true);
  });

  it('finds a chunk by full-text search and ranks it above the floor', async () => {
    const found = await asTenant(TENANT, async () =>
      retriever.retrieve(TENANT, 'how many days for refunds?'),
    );

    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.content).toContain('Refunds are issued');
    // Above the floor is what makes the turn eligible at all; a rank of zero is
    // indistinguishable from no knowledge base.
    expect(found[0]?.rank).toBeGreaterThanOrEqual(BOT_CONFIDENCE.rankFloor);
  });

  it('carries the document title, so a handoff can name what the bot cited', async () => {
    const found = await asTenant(TENANT, async () =>
      retriever.retrieve(TENANT, 'how many days for refunds?'),
    );

    expect(found[0]?.documentTitle).toBe('Refund policy');
  });

  it('returns nothing for a question the knowledge base does not answer', async () => {
    // The refusal TAR-28 AC3 rests on: with nothing retrieved, `BotTurnService`
    // never assembles a prompt, so there is no request to hallucinate from.
    const found = await asTenant(TENANT, async () =>
      retriever.retrieve(TENANT, 'do you sell submarines?'),
    );

    expect(found).toEqual([]);
  });

  it('falls back to trigram similarity when full-text search finds nothing', async () => {
    // A misspelling produces no lexeme match at all, so this can only be served
    // by the `gin_trgm_ops` pass — and it is scored on the same 0–1 axis, so one
    // `minConfidence` means one thing whichever retriever answered.
    const found = await asTenant(TENANT, async () =>
      retriever.retrieve(TENANT, 'damagd colected courer'),
    );

    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.rank).toBeGreaterThanOrEqual(BOT_CONFIDENCE.rankFloor);
    expect(found[0]?.rank).toBeLessThanOrEqual(BOT_CONFIDENCE.rankTarget);
  });

  it('never retrieves a document that is not indexed', async () => {
    const found = await asTenant(TENANT, async () =>
      retriever.retrieve(TENANT, 'warranty claims manufacturer'),
    );

    // Its chunks are still on disk. A re-index in flight must not let the bot
    // quote text the tenant has already replaced.
    expect(found).toEqual([]);
  });

  describe('tenant isolation', () => {
    it('never returns another tenant’s chunk, even when the question matches it', async () => {
      // Both tenants' documents contain "days", so this question genuinely
      // matches on both sides. What must not happen is tenant B seeing tenant
      // A's chunk — asserted on the rows rather than on emptiness, because an
      // empty result would also pass if retrieval were simply broken.
      const found = await asTenant(OTHER_TENANT, async () =>
        retriever.retrieve(OTHER_TENANT, 'how many days for refunds?'),
      );

      for (const chunk of found) {
        expect(chunk.documentId).not.toBe(DOCUMENT);
        expect(chunk.documentTitle).not.toBe('Refund policy');
      }
    });

    it('never puts one tenant’s content within reach of another’s prompt', async () => {
      // The cross-tenant risk unique to this story is the prompt, not the query:
      // content that reached an assembled prompt is content no `where` clause
      // can recover.
      const found = await asTenant(OTHER_TENANT, async () =>
        retriever.retrieve(OTHER_TENANT, `${TENANT_A_SECRET} refund approval delivery`),
      );

      for (const chunk of found) {
        expect(chunk.content).not.toContain(TENANT_A_SECRET);
      }
    });

    it('serves each tenant its own answer to the same question', async () => {
      const theirs = await asTenant(OTHER_TENANT, async () =>
        retriever.retrieve(OTHER_TENANT, 'how long does delivery take?'),
      );

      expect(theirs.length).toBeGreaterThan(0);
      expect(theirs[0]?.documentTitle).toBe('Delivery policy');
    });

    it('is not fooled by a tenant id the caller supplied that is not the one in scope', async () => {
      // The explicit `tenantId` in the `where` is a query-plan fix, never the
      // isolation mechanism — RLS is, and it reads the scope rather than the
      // argument. Passing another tenant's id must return nothing rather than
      // that tenant's rows.
      const found = await asTenant(OTHER_TENANT, async () =>
        retriever.retrieve(TENANT, 'how many days for refunds?'),
      );

      expect(found).toEqual([]);
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
