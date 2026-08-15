import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import { UnscopedModelAccessError } from './prisma.errors';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * TAR-440: the parts of `tenant_signups` that `schema.prisma` cannot express,
 * against a real PostgreSQL.
 *
 * The table and its columns are ordinary Prisma and `migrate diff` reports drift
 * on them loudly. These will not report anything:
 *
 *   1. `tenant_signups_slug_reserved` — **partial unique**. Prisma's describer
 *      skips predicated indexes, so a `migrate dev` that recreated it without
 *      its `WHERE` would make a consumed signup keep holding its slug forever,
 *      and one that dropped the uniqueness would let two people reserve one
 *      subdomain. Neither fails anything.
 *   2. `tenant_signups_expires_at_idx` — partial on the sweep's own predicate.
 *   3. `tenant_signups_desired_slug_format` and
 *      `tenant_signups_provisioned_implies_consumed`. Prisma has no syntax for a
 *      CHECK and its describer ignores them, so a dropped constraint is
 *      invisible to every tool in the repository.
 *   4. **The absence of RLS, and `app-roles.sql` granting the app role nothing.**
 *      This is the one table added since TAR-48 that deliberately carries no
 *      policy, so the grant is the only thing between the app role and an
 *      argon2id password hash for an account nobody owns yet. `app-roles.sql` is
 *      a bootstrap file rather than a migration: nothing re-asserts it on deploy
 *      except the operator remembering to re-run it.
 *   5. The single-use consumption pattern, which is a property of the statement
 *      TAR-405 writes rather than of the schema — asserted here so the shape is
 *      pinned before that story builds on it.
 *
 * Each is asserted twice where a behavioural half exists: once on the catalogue
 * definition, so a narrowed predicate is caught by name, and once behaviourally,
 * so a definition that no longer means what it says still fails.
 * `tenant-lifecycle-schema.int-spec.ts` is the worked example this follows.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. One fixture tenant and
 * a handful of `tar440-` signup rows, deleted before the run as well as after
 * it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT = '40444444-4444-7444-8444-444444444401';

const REQUEST_ID = 'tar440-int-spec';

/** Every fixture row is prefixed with this and removed by it. */
const PREFIX = 'tar440-';

/** Asserts a single row and hands it back — `noUncheckedIndexedAccess` is on. */
function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);

  const [row] = rows;

  if (row === undefined) {
    throw new Error('unreachable: the length assertion above would have failed first');
  }

  return row;
}

describe('tenant signup schema', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

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

  /**
   * A signup as `POST /api/v1/signup` will write one. Every value is a literal
   * that says what it is: no `token_hash` here is the digest of a token that
   * exists, and no `password_hash` is the hash of a password anyone could type.
   */
  function signup(
    slug: string,
    overrides: { consumedAt?: Date | null; expiresAt?: Date; token?: string } = {},
  ): Promise<{ id: string }> {
    return systemPrisma.tenantSignup.create({
      data: {
        email: `${PREFIX}${slug}@fixture.test`,
        desiredSlug: `${PREFIX}${slug}`,
        tenantName: `TAR-440 ${slug}`,
        adminName: 'TAR-440 admin',
        passwordHash: `${PREFIX}${slug}-argon2id-hash-not-a-real-password`,
        // Derived from the slug so `consume()` reads legibly. The one case that
        // writes two signups for one slug passes its own, because two rows
        // cannot share a token digest.
        tokenHash: overrides.token ?? tokenFor(slug),
        expiresAt: overrides.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
        consumedAt: overrides.consumedAt ?? null,
      },
      select: { id: true },
    });
  }

  function tokenFor(slug: string): string {
    return `${PREFIX}${slug}-token-hash-not-a-real-token`;
  }

  /**
   * The consuming statement TAR-405 writes, verbatim: one conditional `UPDATE`
   * whose `WHERE` is the concurrency control. Returns how many rows it claimed.
   */
  function consume(tokenHash: string): Promise<number> {
    return systemPrisma.$executeRaw`
      UPDATE tenant_signups
         SET consumed_at = now()
       WHERE token_hash = ${tokenHash}
         AND consumed_at IS NULL
         AND expires_at > now()
    `;
  }

  async function removeFixture(): Promise<void> {
    await systemPrisma.tenantSignup.deleteMany({
      where: { desiredSlug: { startsWith: PREFIX } },
    });
    await systemPrisma.tenant.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  }

  beforeAll(() => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    await removeFixture();
    await systemPrisma.tenant.create({
      data: { id: TENANT, slug: `${PREFIX}fixture`, name: 'TAR-440 fixture', status: 'active' },
    });
  });

  describe('the slug reservation', () => {
    it('is unique only over the rows that have not been consumed', async () => {
      const index = only(await indexDefinition('tenant_signups_slug_reserved'));

      expect(index.indexdef).toContain('UNIQUE');
      expect(index.indexdef).toContain('(desired_slug)');
      // Losing this predicate makes a completed signup hold its slug forever;
      // losing the uniqueness lets two people reserve one subdomain. Neither
      // fails anything at runtime — see the header.
      expect(index.indexdef).toContain('WHERE (consumed_at IS NULL)');
    });

    it('refuses a second live reservation of one slug', async () => {
      await signup('acme');

      // A distinct token digest, so the only thing left to refuse this is the
      // reservation index.
      await expect(signup('acme', { token: tokenFor('acme-second') })).rejects.toThrow();
    });

    it('lets a consumed signup release nothing, because the tenant now holds the slug', async () => {
      // A consumed row leaves the index, so the name is free again as far as
      // *this* table is concerned. What stops a second tenant taking it is
      // `tenants.slug` and `tenant_domains.hostname`, both globally unique —
      // this table only reserves it for the window before provisioning.
      await signup('acme', { consumedAt: new Date() });

      await expect(signup('acme', { token: tokenFor('acme-again') })).resolves.toBeDefined();
    });

    it('does not release an abandoned reservation on its own', async () => {
      // The trap this schema cannot close by itself: an expired row is still
      // `consumed_at IS NULL`, so it still occupies the index, and the predicate
      // cannot carry `AND expires_at > now()` because an index predicate must be
      // IMMUTABLE. TAR-405's insert path has to delete expired unconsumed rows
      // for the slug first — this asserts the state that makes that necessary,
      // and the delete that stands in for it.
      await signup('lapsed', { expiresAt: new Date(Date.now() - 60_000) });

      const retry = { token: tokenFor('lapsed-retry') };

      await expect(signup('lapsed', retry)).rejects.toThrow();

      await systemPrisma.$executeRaw`
        DELETE FROM tenant_signups
         WHERE desired_slug = ${`${PREFIX}lapsed`}::citext
           AND consumed_at IS NULL
           AND expires_at <= now()
      `;

      await expect(signup('lapsed', retry)).resolves.toBeDefined();
    });

    it('holds the slug as citext, so it compares with `tenants.slug` the way that column behaves', async () => {
      const column = only(
        await systemPrisma.$queryRaw<{ data_type: string }[]>`
          SELECT udt_name AS data_type
            FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'tenant_signups'
             AND column_name = 'desired_slug'
        `,
      );

      expect(column.data_type).toBe('citext');
    });

    it('refuses a slug the tenant could never be given', async () => {
      const check = only(await checkDefinition('tenant_signups_desired_slug_format'));

      expect(check.definition).toContain('~');

      // `TenantSlugSchema`'s three failure modes, and the reason the constraint
      // is here at all: the slug becomes a permanent, globally unique DNS label,
      // so a reservation provisioning would reject squats a name for nothing.
      const invalid = ['UPPER', 'ab', '-leading', 'trailing-', 'has space', 'under_score'];

      for (const slug of invalid) {
        await expect(
          systemPrisma.tenantSignup.create({
            data: {
              email: `${PREFIX}invalid@fixture.test`,
              desiredSlug: slug,
              tenantName: 'TAR-440 invalid',
              adminName: 'TAR-440 admin',
              passwordHash: `${PREFIX}invalid-argon2id-hash-not-a-real-password`,
              tokenHash: tokenFor(`invalid-${slug}`),
              expiresAt: new Date(Date.now() + 60_000),
            },
          }),
        ).rejects.toThrow();
      }
    });
  });

  describe('a verification link is single-use', () => {
    it('is claimed by the conditional UPDATE exactly once', async () => {
      await signup('once');
      const token = tokenFor('once');

      // The first call wins. The second matches nothing — not an error, just no
      // row, which is what makes a replayed verification a no-op rather than a
      // second `provision()`.
      expect(await consume(token)).toBe(1);
      expect(await consume(token)).toBe(0);
    });

    it('will not claim a lapsed signup', async () => {
      await signup('stale', { expiresAt: new Date(Date.now() - 60_000) });

      expect(await consume(tokenFor('stale'))).toBe(0);
    });

    it('holds the token digest unique, so a lookup by hash has one answer', async () => {
      await signup('first');

      await expect(
        systemPrisma.tenantSignup.create({
          data: {
            email: `${PREFIX}second@fixture.test`,
            desiredSlug: `${PREFIX}second`,
            tenantName: 'TAR-440 second',
            adminName: 'TAR-440 admin',
            passwordHash: `${PREFIX}second-argon2id-hash-not-a-real-password`,
            // The digest of the row above, on a different signup.
            tokenHash: tokenFor('first'),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('the tenant a signup produced', () => {
    it('cannot be recorded on a row that was never consumed', async () => {
      const check = only(await checkDefinition('tenant_signups_provisioned_implies_consumed'));

      expect(check.definition).toContain('provisioned_tenant_id IS NULL');
      expect(check.definition).toContain('consumed_at IS NOT NULL');

      const { id } = await signup('unconsumed');

      await expect(
        systemPrisma.tenantSignup.update({
          where: { id },
          data: { provisionedTenantId: TENANT },
        }),
      ).rejects.toThrow();
    });

    it('is recorded after consumption, which is the order the flow runs in', async () => {
      // Consume first — that UPDATE is what wins the race — then provision, then
      // write back the id. The constraint is one-way precisely so this sequence
      // is legal; a biconditional would force the flow to abandon it.
      const { id } = await signup('linked');

      await consume(tokenFor('linked'));

      const linked = await systemPrisma.tenantSignup.update({
        where: { id },
        data: { provisionedTenantId: TENANT },
        select: { provisionedTenantId: true, consumedAt: true },
      });

      expect(linked.provisionedTenantId).toBe(TENANT);
      expect(linked.consumedAt).not.toBeNull();
    });

    it('outlives the tenant, because the column carries no foreign key', async () => {
      // The reason it is a bare uuid: a purged tenant must not take the record
      // of where it came from with it, and a foreign key would either cascade
      // the row away or refuse the delete.
      const { id } = await signup('outlives');
      await consume(tokenFor('outlives'));
      await systemPrisma.tenantSignup.update({
        where: { id },
        data: { provisionedTenantId: TENANT },
      });

      await systemPrisma.tenant.delete({ where: { id: TENANT } });

      const survivor = await systemPrisma.tenantSignup.findUniqueOrThrow({
        where: { id },
        select: { provisionedTenantId: true },
      });

      expect(survivor.provisionedTenantId).toBe(TENANT);
    });
  });

  describe('the expiry sweep', () => {
    it('reads an index partial on its own predicate', async () => {
      const index = only(await indexDefinition('tenant_signups_expires_at_idx'));

      expect(index.indexdef).toContain('(expires_at)');
      // Without the predicate the sweep is handed every signup ever completed —
      // a consumed row's `expires_at` is in the past too — and the index grows
      // with the customer count forever.
      expect(index.indexdef).toContain('WHERE (consumed_at IS NULL)');
    });

    it('finds the abandoned reservations and leaves the consumed rows alone', async () => {
      await signup('sweep-expired', { expiresAt: new Date(Date.now() - 60_000) });
      await signup('sweep-live');
      await signup('sweep-consumed', {
        expiresAt: new Date(Date.now() - 60_000),
        consumedAt: new Date(),
      });

      const swept = await systemPrisma.tenantSignup.deleteMany({
        where: { consumedAt: null, expiresAt: { lte: new Date() } },
      });

      expect(swept.count).toBe(1);

      const left = await systemPrisma.tenantSignup.findMany({
        where: { desiredSlug: { startsWith: PREFIX } },
        select: { desiredSlug: true },
        orderBy: { desiredSlug: 'asc' },
      });

      expect(left.map((row) => row.desiredSlug)).toEqual([
        `${PREFIX}sweep-consumed`,
        `${PREFIX}sweep-live`,
      ]);
    });
  });

  describe('the grant is the enforcement', () => {
    it('carries no row-level security, which is the decision rather than an omission', async () => {
      const table = only(
        await systemPrisma.$queryRaw<{ enabled: boolean; policies: bigint }[]>`
          SELECT c.relrowsecurity AS enabled,
                 (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'tenant_signups'
        `,
      );

      // A policy needs a tenant to compare against and there is none: at insert
      // the tenant has not been provisioned and the caller is anonymous. This
      // asserts the state `pnpm db:verify:rls` allows only because the grant
      // below closes it.
      expect(table.enabled).toBe(false);
      expect(Number(table.policies)).toBe(0);
    });

    it('grants the app role nothing at all, and the system role everything', async () => {
      const grants = only(
        await systemPrisma.$queryRaw<
          {
            app_select: boolean;
            app_insert: boolean;
            app_update: boolean;
            app_delete: boolean;
            system_select: boolean;
            system_insert: boolean;
            system_update: boolean;
            system_delete: boolean;
          }[]
        >`
          SELECT
            has_table_privilege('whatsappcrm_app', 'tenant_signups', 'SELECT') AS app_select,
            has_table_privilege('whatsappcrm_app', 'tenant_signups', 'INSERT') AS app_insert,
            has_table_privilege('whatsappcrm_app', 'tenant_signups', 'UPDATE') AS app_update,
            has_table_privilege('whatsappcrm_app', 'tenant_signups', 'DELETE') AS app_delete,
            has_table_privilege('whatsappcrm_system', 'tenant_signups', 'SELECT') AS system_select,
            has_table_privilege('whatsappcrm_system', 'tenant_signups', 'INSERT') AS system_insert,
            has_table_privilege('whatsappcrm_system', 'tenant_signups', 'UPDATE') AS system_update,
            has_table_privilege('whatsappcrm_system', 'tenant_signups', 'DELETE') AS system_delete
        `,
      );

      // With no policy, a single grant here is an unfiltered read of every
      // pending signup in the platform — an argon2id hash and a verification
      // digest for an account nobody owns yet.
      expect(grants).toEqual({
        app_select: false,
        app_insert: false,
        app_update: false,
        app_delete: false,
        system_select: true,
        system_insert: true,
        system_update: true,
        system_delete: true,
      });
    });

    it('is refused by TenantPrisma before a statement is ever sent', async () => {
      await signup('refused');

      await asTenant(TENANT, async () => {
        await expect(tenantPrisma.tenantSignup.findMany()).rejects.toBeInstanceOf(
          UnscopedModelAccessError,
        );
      });
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
