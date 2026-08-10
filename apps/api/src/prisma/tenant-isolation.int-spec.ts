import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import { MissingTenantContextError, UnscopedModelAccessError } from './prisma.errors';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * The proof, against a real PostgreSQL with TAR-48's policies applied.
 *
 * A unit test can show that the client composes the right statement; only this
 * can show that the statement has the effect it is there for. Everything below
 * runs as `whatsappcrm_app` — the role that holds no `BYPASSRLS` — so a
 * regression in the extension, the policies, the grants or the roles fails here.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Two fixture
 * tenants and their contacts, every row carrying a fixed id and a
 * `tar49-fixture` marker, deleted before the run as well as after it so an
 * interrupted run cleans up on the next one. Point `pnpm test:db` at a local or
 * disposable database.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '49444444-4444-7444-8444-444444444401';
const TENANT_B = '49444444-4444-7444-8444-444444444402';
const CONTACT_A = '49444444-4444-7444-8444-4444444444a1';
const CONTACT_B = '49444444-4444-7444-8444-4444444444b1';

const REQUEST_ID = 'tar49-int-spec';

describe('tenant isolation, end to end', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

  /**
   * Runs `work` as if a request for `tenantId` had been resolved by the auth
   * guard.
   *
   * The `await` inside the callback is load-bearing, and worth knowing about
   * beyond this file: a `PrismaPromise` does not start until something calls
   * `.then()` on it, so returning one out of the scope unawaited would run the
   * query in whatever context the caller happens to be in. Ordinary service
   * code awaits in place and never hits this; a handler that collects promises
   * and awaits them later would.
   */
  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null },
      async () => await work(),
    );
  }

  /** Runs `work` inside a context scope that never resolved a tenant. */
  function asUnresolved<T>(work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId: null, userId: null },
      async () => await work(),
    );
  }

  async function removeFixture(): Promise<void> {
    await systemPrisma.contact.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    await removeFixture();

    // Written through SystemPrisma: this is the provisioning path, and it is the
    // only way to create a tenant at all — see the `Tenant` policy below.
    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar49-fixture-a', name: 'TAR-49 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar49-fixture-b', name: 'TAR-49 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.contact.createMany({
      data: [
        {
          id: CONTACT_A,
          tenantId: TENANT_A,
          phoneE164: '+10000004901',
          displayName: 'tar49-fixture A contact',
        },
        {
          id: CONTACT_B,
          tenantId: TENANT_B,
          phoneE164: '+10000004902',
          displayName: 'tar49-fixture B contact',
        },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  describe('fail-closed', () => {
    it('refuses a read with no tenant in scope', async () => {
      await asUnresolved(async () => {
        await expect(tenantPrisma.contact.findMany()).rejects.toBeInstanceOf(
          MissingTenantContextError,
        );
      });
    });

    it('refuses a write with no tenant in scope', async () => {
      await asUnresolved(async () => {
        await expect(
          tenantPrisma.contact.create({
            data: { tenantId: TENANT_A, phoneE164: '+10000004999' },
          }),
        ).rejects.toBeInstanceOf(MissingTenantContextError);
      });
    });

    it('refuses raw SQL with no tenant in scope', async () => {
      await asUnresolved(async () => {
        await expect(tenantPrisma.$queryRaw`SELECT 1`).rejects.toBeInstanceOf(
          MissingTenantContextError,
        );
      });
    });

    it('refuses outside any context scope at all, as a queue worker would be', async () => {
      await expect(tenantPrisma.contact.findMany()).rejects.toBeInstanceOf(
        MissingTenantContextError,
      );
    });

    it('leaves nothing behind: the refused write did not reach the database', async () => {
      const rows = await systemPrisma.contact.findMany({
        where: { phoneE164: '+10000004999' },
        select: { id: true },
      });

      expect(rows).toHaveLength(0);
    });
  });

  describe('per-tenant scoping', () => {
    it('shows each tenant only its own rows', async () => {
      const seenByA = await asTenant(TENANT_A, () =>
        tenantPrisma.contact.findMany({ select: { id: true } }),
      );
      const seenByB = await asTenant(TENANT_B, () =>
        tenantPrisma.contact.findMany({ select: { id: true } }),
      );

      expect(seenByA).toEqual([{ id: CONTACT_A }]);
      expect(seenByB).toEqual([{ id: CONTACT_B }]);
    });

    it('returns nothing when one tenant asks for another tenant by id', async () => {
      const stolen = await asTenant(TENANT_A, () =>
        tenantPrisma.contact.findUnique({ where: { id: CONTACT_B }, select: { id: true } }),
      );

      expect(stolen).toBeNull();
    });

    it('does not leak a tenant across a reused pooled connection', async () => {
      // The GUC is transaction-local, so it must not survive into the next
      // statement on the same connection. Interleaving the two tenants on one
      // client is what would expose a session-level `set_config`.
      const observed: string[][] = [];

      for (const tenantId of [TENANT_A, TENANT_B, TENANT_A, TENANT_B]) {
        const rows = await asTenant(tenantId, () =>
          tenantPrisma.contact.findMany({ select: { tenantId: true } }),
        );
        observed.push(rows.map((row) => row.tenantId));
      }

      expect(observed).toEqual([[TENANT_A], [TENANT_B], [TENANT_A], [TENANT_B]]);
    });

    it('scopes raw SQL, which no argument-rewriting extension could reach', async () => {
      const rows = await asTenant(
        TENANT_A,
        () => tenantPrisma.$queryRaw<{ tenant_id: string }[]>`SELECT tenant_id FROM contacts`,
      );

      expect(rows).toEqual([{ tenant_id: TENANT_A }]);
    });

    it('rejects a write that carries another tenant id', async () => {
      await asTenant(TENANT_A, async () => {
        // WITH CHECK on the tenant_isolation policy. The row never lands, so a
        // handler that took `tenantId` from a request body cannot plant one.
        await expect(
          tenantPrisma.contact.create({
            data: { tenantId: TENANT_B, phoneE164: '+10000004998' },
          }),
        ).rejects.toThrow();
      });

      const planted = await systemPrisma.contact.findMany({
        where: { phoneE164: '+10000004998' },
        select: { id: true },
      });
      expect(planted).toHaveLength(0);
    });

    it('matches no rows when one tenant updates or deletes another tenant', async () => {
      const [updated, deleted] = await asTenant(TENANT_A, async () => [
        await tenantPrisma.contact.updateMany({
          where: { tenantId: TENANT_B },
          data: { displayName: 'hijacked' },
        }),
        await tenantPrisma.contact.deleteMany({ where: { tenantId: TENANT_B } }),
      ]);

      expect(updated.count).toBe(0);
      expect(deleted.count).toBe(0);

      const survivor = await systemPrisma.contact.findUnique({
        where: { id: CONTACT_B },
        select: { displayName: true },
      });
      expect(survivor?.displayName).toBe('tar49-fixture B contact');
    });

    it('writes its own rows normally', async () => {
      const created = await asTenant(TENANT_A, () =>
        tenantPrisma.contact.create({
          data: { tenantId: TENANT_A, phoneE164: '+10000004997' },
          select: { id: true, tenantId: true },
        }),
      );

      expect(created.tenantId).toBe(TENANT_A);

      await asTenant(TENANT_A, () => tenantPrisma.contact.delete({ where: { id: created.id } }));
    });
  });

  describe('$tenantTransaction', () => {
    it('scopes every statement in the transaction and commits them together', async () => {
      const phone = '+10000004996';

      const created = await asTenant(TENANT_A, () =>
        tenantPrisma.$tenantTransaction(async (tx) => {
          const contact = await tx.contact.create({
            data: { tenantId: TENANT_A, phoneE164: phone },
            select: { id: true },
          });
          const visible = await tx.contact.findMany({ select: { tenantId: true } });

          expect(visible.map((row) => row.tenantId)).toEqual([TENANT_A, TENANT_A]);
          return contact;
        }),
      );

      await asTenant(TENANT_A, () => tenantPrisma.contact.delete({ where: { id: created.id } }));
    });

    it('rolls back, leaving no partial write behind', async () => {
      const phone = '+10000004995';

      await asTenant(TENANT_A, async () => {
        await expect(
          tenantPrisma.$tenantTransaction(async (tx) => {
            await tx.contact.create({ data: { tenantId: TENANT_A, phoneE164: phone } });
            throw new Error('deliberate rollback');
          }),
        ).rejects.toThrow('deliberate rollback');
      });

      const leftover = await systemPrisma.contact.findMany({
        where: { phoneE164: phone },
        select: { id: true },
      });
      expect(leftover).toHaveLength(0);
    });

    it('refuses to open with no tenant in scope', async () => {
      await asUnresolved(async () => {
        await expect(
          tenantPrisma.$tenantTransaction(async (tx) => tx.contact.findMany()),
        ).rejects.toBeInstanceOf(MissingTenantContextError);
      });
    });
  });

  describe('the three models RLS does not protect', () => {
    it('narrows Tenant reads to the tenant in scope', async () => {
      const visible = await asTenant(TENANT_A, () =>
        tenantPrisma.tenant.findMany({
          where: { slug: { startsWith: 'tar49-fixture' } },
          select: { id: true },
        }),
      );

      expect(visible).toEqual([{ id: TENANT_A }]);
    });

    it('returns null for another tenant looked up by its unique slug', async () => {
      const other = await asTenant(TENANT_A, () =>
        tenantPrisma.tenant.findUnique({ where: { slug: 'tar49-fixture-b' } }),
      );

      expect(other).toBeNull();
    });

    it('refuses to write a Tenant', async () => {
      await asTenant(TENANT_A, async () => {
        await expect(
          tenantPrisma.tenant.update({ where: { id: TENANT_A }, data: { name: 'renamed' } }),
        ).rejects.toBeInstanceOf(UnscopedModelAccessError);
      });
    });

    it('refuses WebhookEvent entirely', async () => {
      await asTenant(TENANT_A, async () => {
        await expect(tenantPrisma.webhookEvent.findMany()).rejects.toBeInstanceOf(
          UnscopedModelAccessError,
        );
      });
    });

    it('refuses to write a Plan, and allows reading the shared catalogue', async () => {
      await asTenant(TENANT_A, async () => {
        await expect(
          tenantPrisma.plan.create({
            data: { key: 'tar49', name: 'TAR-49', priceMinorUnits: 0, entitlements: {} },
          }),
        ).rejects.toBeInstanceOf(UnscopedModelAccessError);

        await expect(tenantPrisma.plan.findMany()).resolves.toEqual(expect.any(Array));
      });
    });
  });

  describe('SystemPrisma', () => {
    it('reads across tenants with no tenant in scope, which is what it is for', async () => {
      const rows = await asUnresolved(() =>
        systemPrisma.contact.findMany({
          where: { id: { in: [CONTACT_A, CONTACT_B] } },
          select: { tenantId: true },
          orderBy: { tenantId: 'asc' },
        }),
      );

      expect(rows).toEqual([{ tenantId: TENANT_A }, { tenantId: TENANT_B }]);
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
