import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * TAR-475: the shape `canned_responses` has to hold for TAR-31's quick replies,
 * against a real PostgreSQL as `whatsappcrm_app`.
 *
 * Both deltas in the Data Model section of
 * `docs/architecture/0011-canned-responses-contract.md` are invisible to the
 * rest of the toolchain, which is why this file exists:
 *
 *   * **The four bounds are CHECK constraints**, and Prisma's schema language
 *     cannot express one. Its describer does not report one either, so
 *     `migrate dev` proposes neither to create nor to drop them — nothing
 *     regenerates them from `schema.prisma` and nothing notices if they
 *     disappear. Same arrangement, and the same reasoning, as
 *     `tickets_one_active_per_contact` (TAR-74) and
 *     `assignment_rules_active_has_one_target` (TAR-285).
 *   * **`shortcut` being `citext` is what makes a lookup case-insensitive.**
 *     The column type survives no other check: revert it to `text` and every
 *     test that only inserts one spelling goes on passing, while
 *     `WHERE shortcut = '/Hours'` silently stops finding `/hours` — which is
 *     the read the composer's picker performs.
 *
 *     Note what it does *not* buy here, established by running it rather than
 *     assumed: `citext` cannot make `UNIQUE (tenant_id, shortcut)` do any work
 *     the grammar has not already done, because
 *     `canned_responses_shortcut_format` forbids uppercase outright, so no two
 *     admissible values can differ only by case. That is unlike `teams.name`
 *     and `tenants.slug`, where mixed case is legal and the folded index is the
 *     only thing preventing a duplicate. Kept for the lookup, and because 0011
 *     decision 4 rules on it — not because it de-duplicates anything.
 *
 * So the assertions here are half catalog and half behaviour, deliberately: the
 * catalog half names the regression, the behaviour half proves the guarantee. A
 * definition asserted by name alone would pass against a constraint whose body
 * had been widened.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids and a `tar475-fixture` marker, deleted before the run as
 * well as after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '47547547-4754-7475-8475-475475475a01';
const TENANT_B = '47547547-4754-7475-8475-475475475b01';

const AGENT_A = '47547547-4754-7475-8475-475475475a02';

const REQUEST_ID = 'tar475-int-spec';

let nextResponseId = 0;

/** Fixture ids that stay inside the tenant's prefix, so cleanup catches them. */
function responseId(): string {
  nextResponseId += 1;

  return `47547547-4754-7475-8475-4754754${String(nextResponseId).padStart(5, '0')}`;
}

describe('canned response schema', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null, principal: null },
      async () => await work(),
    );
  }

  /** A valid row, so each test varies only the column it is about. */
  function validRow(
    overrides: Partial<Prisma.CannedResponseUncheckedCreateInput> = {},
  ): Prisma.CannedResponseUncheckedCreateInput {
    return {
      id: responseId(),
      tenantId: TENANT_A,
      shortcut: `/hours${responseId().slice(-4)}`,
      title: 'Opening hours',
      body: 'We are open 9am to 5pm, Sunday to Thursday.',
      ...overrides,
    };
  }

  async function removeFixture(): Promise<void> {
    // canned_responses and users both cascade from the tenant, so one delete is
    // enough and stays correct as the schema grows.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar475-fixture-a', name: 'TAR-475 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar475-fixture-b', name: 'TAR-475 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.user.create({
      data: {
        id: AGENT_A,
        tenantId: TENANT_A,
        email: 'agent@tar475-fixture-a.invalid',
        name: 'tar475-fixture A agent',
        role: 'agent',
        status: 'active',
      },
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    await systemPrisma.cannedResponse.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
  });

  describe('the catalog', () => {
    it('stores the shortcut as citext', async () => {
      const columns = await systemPrisma.$queryRaw<{ column_name: string; udt_name: string }[]>`
        SELECT column_name, udt_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'canned_responses'
      `;
      const byName = new Map(columns.map((column) => [column.column_name, column.udt_name]));

      // `text` here still passes every single-spelling insert while admitting
      // the pair delta 1 exists to prevent.
      expect(byName.get('shortcut')).toBe('citext');
    });

    it('keeps the unique index on (tenant_id, shortcut) and the creator index', async () => {
      const indexes = await systemPrisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'canned_responses'
      `;
      const byName = new Map(indexes.map((index) => [index.indexname, index.indexdef]));

      const unique = byName.get('canned_responses_tenant_id_shortcut_key');
      expect(unique).toContain('CREATE UNIQUE INDEX');
      // `tenant_id` leads, so a conflict can never be caused by another tenant's
      // row — a unique index is not RLS-aware (conventions, rule 3).
      expect(unique).toContain('(tenant_id, shortcut)');

      // 0011 recommends dropping this one; TAR-475 keeps it because the
      // composite foreign key's integrity check reads exactly these two columns
      // when a `users` row is deleted, and Postgres does not index the
      // referencing side for you. Asserted so the drop is a decision rather than
      // a line that quietly reappeared.
      expect(byName.has('canned_responses_tenant_id_created_by_user_id_idx')).toBe(true);
    });

    it.each([
      ['canned_responses_shortcut_format', '~'],
      ['canned_responses_title_length', 'length(title)'],
      ['canned_responses_body_length', 'length(body)'],
      ['canned_responses_is_shared', 'is_shared'],
    ])('carries %s', async (name, fragment) => {
      // Asserting the body rather than the name: a constraint quietly widened to
      // `CHECK (true)` passes a name-only check and fails every behaviour test
      // below.
      const [constraint] = await systemPrisma.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'public.canned_responses'::regclass AND conname = ${name}
      `;

      expect(constraint?.definition).toContain(fragment);
    });

    it('bounds the shortcut at 40 characters including the slash', async () => {
      // The one place this migration departs from 0011's Data Model table, which
      // writes `{0,39}` while the contract's own published constant,
      // `CANNED_RESPONSE_LIMITS.shortcutLength`, is 40. Asserted explicitly so
      // that reading is recorded rather than inferred from a regex.
      const [constraint] = await systemPrisma.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'public.canned_responses'::regclass
          AND conname = 'canned_responses_shortcut_format'
      `;

      expect(constraint?.definition).toContain('{0,38}');
    });

    it('still has row-level security, which this migration must not touch', async () => {
      const [table] = await systemPrisma.$queryRaw<{ enabled: boolean; forced: boolean }[]>`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = 'public.canned_responses'::regclass
      `;

      expect(table).toEqual({ enabled: true, forced: true });

      const policies = await systemPrisma.$queryRaw<{ policyname: string }[]>`
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'canned_responses'
      `;

      expect(policies.map((policy) => policy.policyname)).toContain('tenant_isolation');
    });
  });

  describe('shortcuts', () => {
    it('refuses a second shortcut that differs only by case', async () => {
      await systemPrisma.cannedResponse.create({
        data: validRow({ shortcut: '/hours' }),
      });

      // The composer matches case-insensitively against its local copy, so
      // `/Hours` beside `/hours` is two rows it cannot choose between
      // (0011, decision 4).
      //
      // ⚠️ Worth knowing which constraint answers: it is
      // `canned_responses_shortcut_format`, not the unique index. The grammar
      // forbids uppercase outright, so a case-collision cannot be *reached*
      // through a value the format CHECK admits — which means `citext` is
      // redundant for uniqueness here, unlike `teams.name`, where mixed case is
      // legal. It is not redundant for *lookup*; see the next test, which is
      // what it actually buys and why it stays.
      await expect(
        systemPrisma.cannedResponse.create({ data: validRow({ shortcut: '/Hours' }) }),
      ).rejects.toThrow();
    });

    it('lets two tenants each hold the same shortcut', async () => {
      // What the index must NOT constrain. `tenant_id` leads it for exactly this
      // reason, and it is why the constraint cannot be used to probe another
      // tenant's shortcut namespace.
      await systemPrisma.cannedResponse.createMany({
        data: [
          validRow({ shortcut: '/hours' }),
          validRow({ tenantId: TENANT_B, shortcut: '/hours' }),
        ],
      });

      expect(
        await systemPrisma.cannedResponse.count({
          where: { tenantId: { in: [TENANT_A, TENANT_B] } },
        }),
      ).toBe(2);
    });

    it('finds a response by a spelling nobody typed', async () => {
      // The other half of citext, and the one the picker depends on: an agent
      // typing `/HOURS` reaches the row saved as `/hours`.
      await systemPrisma.cannedResponse.create({ data: validRow({ shortcut: '/hours' }) });

      const found = await systemPrisma.cannedResponse.findFirst({
        where: { tenantId: TENANT_A, shortcut: '/HOURS' },
        select: { shortcut: true },
      });

      expect(found?.shortcut).toBe('/hours');
    });

    it.each([
      ['no leading slash', 'hours'],
      ['a second slash', '/support/hours'],
      ['whitespace', '/opening hours'],
      ['uppercase', '/Hours'],
      ['a leading hyphen after the slash', '/-hours'],
      ['nothing after the slash', '/'],
      ['41 characters', `/${'a'.repeat(40)}`],
    ])('refuses a shortcut with %s', async (_label, shortcut) => {
      // The composer opens its picker on `/` and matches the rest of the token,
      // so each of these is either unreachable or ambiguous once typed.
      await expect(
        systemPrisma.cannedResponse.create({ data: validRow({ shortcut }) }),
      ).rejects.toThrow();
    });

    it('accepts the longest shortcut the published constant allows', async () => {
      // 40 characters including the slash — the boundary the CHECK and
      // `CANNED_RESPONSE_LIMITS.shortcutLength` have to agree on.
      await expect(
        systemPrisma.cannedResponse.create({ data: validRow({ shortcut: `/${'a'.repeat(39)}` }) }),
      ).resolves.toMatchObject({ tenantId: TENANT_A });
    });
  });

  describe('title and body bounds', () => {
    it.each([
      ['an empty title', { title: '' }],
      ['a title over 80 characters', { title: 'a'.repeat(81) }],
      ['an empty body', { body: '' }],
      ['a body over 4096 characters', { body: 'a'.repeat(4097) }],
    ])('refuses %s', async (_label, overrides) => {
      await expect(
        systemPrisma.cannedResponse.create({ data: validRow(overrides) }),
      ).rejects.toThrow();
    });

    it.each([
      ['a title at 80 characters', { title: 'a'.repeat(80) }],
      ['a body at 4096 characters', { body: 'a'.repeat(4096) }],
    ])('accepts %s', async (_label, overrides) => {
      // 4096 is `SendTextInputSchema.body`'s ceiling, so a body at the boundary
      // is still sendable as-is — that is the whole point of the number.
      await expect(
        systemPrisma.cannedResponse.create({ data: validRow(overrides) }),
      ).resolves.toMatchObject({ tenantId: TENANT_A });
    });

    it('covers UPDATE as well as INSERT', async () => {
      // The half an application-level check on the create path would miss.
      const row = await systemPrisma.cannedResponse.create({ data: validRow() });

      await expect(
        systemPrisma.cannedResponse.update({ where: { id: row.id }, data: { title: '' } }),
      ).rejects.toThrow();
    });
  });

  describe('the shared-library invariant', () => {
    it('refuses a row that is not shared', async () => {
      // TAR-31 scopes v1 to a tenant-shared library, so every read path assumes
      // this. A future personal-responses story drops the constraint — and
      // changes the realtime audience with it (0011, open question 3).
      await expect(
        systemPrisma.cannedResponse.create({ data: validRow({ isShared: false }) }),
      ).rejects.toThrow();
    });

    it('defaults a row to shared', async () => {
      await expect(systemPrisma.cannedResponse.create({ data: validRow() })).resolves.toMatchObject(
        { isShared: true },
      );
    });
  });

  describe('through the app role, under RLS', () => {
    it('shows a tenant only its own responses', async () => {
      await systemPrisma.cannedResponse.createMany({
        data: [
          validRow({ shortcut: '/hours' }),
          validRow({ tenantId: TENANT_B, shortcut: '/refund' }),
        ],
      });

      const seen = await asTenant(TENANT_A, () =>
        tenantPrisma.cannedResponse.findMany({ select: { tenantId: true } }),
      );

      expect(seen).toEqual([{ tenantId: TENANT_A }]);
    });

    it('matches no rows when one tenant tries to edit another tenant’s response', async () => {
      const foreign = await systemPrisma.cannedResponse.create({
        data: validRow({ tenantId: TENANT_B, shortcut: '/refund', body: 'B body' }),
      });

      const edited = await asTenant(TENANT_A, () =>
        tenantPrisma.cannedResponse.updateMany({
          where: { id: foreign.id },
          data: { body: 'A rewrote it' },
        }),
      );

      // Zero rows matched, not an error — which is what lets the service report
      // `not_found` rather than a 403 that would confirm the id exists
      // somewhere (0011, security and access, item 2).
      expect(edited.count).toBe(0);
      expect(
        await systemPrisma.cannedResponse.findUnique({ where: { id: foreign.id } }),
      ).toMatchObject({ body: 'B body' });
    });

    it('matches no rows when one tenant tries to delete another tenant’s response', async () => {
      const foreign = await systemPrisma.cannedResponse.create({
        data: validRow({ tenantId: TENANT_B, shortcut: '/refund' }),
      });

      const deleted = await asTenant(TENANT_A, () =>
        tenantPrisma.cannedResponse.deleteMany({ where: { id: foreign.id } }),
      );

      expect(deleted.count).toBe(0);
      expect(
        await systemPrisma.cannedResponse.findUnique({ where: { id: foreign.id } }),
      ).not.toBeNull();
    });

    it('lets a tenant create a shortcut another tenant already holds', async () => {
      // The isolation property stated as behaviour: B holding `/hours` must not
      // be visible to A as a conflict, or the unique constraint becomes an
      // oracle for another tenant's namespace.
      await systemPrisma.cannedResponse.create({
        data: validRow({ tenantId: TENANT_B, shortcut: '/hours' }),
      });

      await asTenant(TENANT_A, async () => {
        await expect(
          tenantPrisma.cannedResponse.create({
            data: {
              id: responseId(),
              tenantId: TENANT_A,
              shortcut: '/hours',
              title: 'A',
              body: 'A',
            },
          }),
        ).resolves.toMatchObject({ tenantId: TENANT_A });
      });
    });

    it('refuses to credit a response to another tenant’s user', async () => {
      // The row carries tenant A's own tenant_id, so the RLS WITH CHECK is
      // satisfied and the policy has nothing to say. The composite foreign key
      // to `(tenant_id, id)` is what rejects it — the difference between
      // "invisible" and "cannot be referenced" (conventions, rule 2).
      const foreignUser = '47547547-4754-7475-8475-475475475b02';

      await systemPrisma.user.create({
        data: {
          id: foreignUser,
          tenantId: TENANT_B,
          email: 'agent@tar475-fixture-b.invalid',
          name: 'tar475-fixture B agent',
          role: 'agent',
          status: 'active',
        },
      });

      await asTenant(TENANT_A, async () => {
        await expect(
          tenantPrisma.cannedResponse.create({
            data: {
              id: responseId(),
              tenantId: TENANT_A,
              shortcut: '/stolen',
              title: 'Stolen',
              body: 'Stolen',
              createdByUserId: foreignUser,
            },
          }),
        ).rejects.toThrow();
      });

      expect(await systemPrisma.cannedResponse.count({ where: { tenantId: TENANT_A } })).toBe(0);
    });

    it('keeps the response when its creator is credited and still present', async () => {
      await expect(
        systemPrisma.cannedResponse.create({ data: validRow({ createdByUserId: AGENT_A }) }),
      ).resolves.toMatchObject({ createdByUserId: AGENT_A });
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
