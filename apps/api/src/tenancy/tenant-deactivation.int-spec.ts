import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import {
  TenantDeactivationService,
  TENANT_DEACTIVATED_ACTION,
} from './tenant-deactivation.service';

/**
 * TAR-19's third acceptance criterion, against a real PostgreSQL with TAR-48's
 * policies and TAR-51's `assert_tenant_active` applied:
 *
 *   * a deactivated tenant's agents reach **nothing** — reads, writes, raw SQL
 *     and transactions all refused, on the next statement after the
 *     deactivation commits;
 *   * its data is **retained**, visible through `SystemPrisma` throughout and
 *     readable again in full the moment the tenant is active again;
 *   * **its neighbour is unaffected** — the regression the criterion asks for.
 *
 * None of that is assertable without a database: the block is a function the
 * policies' GUC passes through, and a mock would prove only that this file
 * agrees with itself.
 *
 * Each tenant below belongs to exactly one concern, so the file passes in any
 * order and a failure names one scenario rather than cascading.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Every fixture row
 * carries a `tar51-fixture` slug prefix and is removed before the run as well as
 * after it, so an interrupted run cleans up on the next one. Point `pnpm test:db`
 * at a local or disposable database.
 *
 * Prerequisites — the four commands in the README:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const FIXTURE_PREFIX = 'tar51-fixture';

/** Deactivated by the suite. */
const DEACTIVATED_ID = '51444444-4444-7444-8444-444444444401';
/** Its neighbour, active throughout: the regression subject. */
const NEIGHBOUR_ID = '51444444-4444-7444-8444-444444444402';
/** Never finished provisioning, so never active. */
const PENDING_ID = '51444444-4444-7444-8444-444444444403';
/** Deactivated and then put back, to show the data was only ever hidden. */
const RESTORED_ID = '51444444-4444-7444-8444-444444444404';

const CONTACT_OF = {
  deactivated: '51444444-4444-7444-8444-4444444444a1',
  neighbour: '51444444-4444-7444-8444-4444444444a2',
  pending: '51444444-4444-7444-8444-4444444444a3',
  restored: '51444444-4444-7444-8444-4444444444a4',
} as const;

const REQUEST_ID = 'tar51-int-spec';

describe('tenant deactivation, end to end', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let deactivation: TenantDeactivationService;

  /** Runs `work` as if a request for `tenantId` had been resolved by the auth guard. */
  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null },
      async () => await work(),
    );
  }

  async function removeFixture(): Promise<void> {
    // `contacts` and `audit_logs` cascade from `tenants`.
    await systemPrisma.tenant.deleteMany({ where: { slug: { startsWith: FIXTURE_PREFIX } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);
    deactivation = new TenantDeactivationService(systemPrisma);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        {
          id: DEACTIVATED_ID,
          slug: `${FIXTURE_PREFIX}-deactivated`,
          name: 'Off',
          status: 'active',
        },
        {
          id: NEIGHBOUR_ID,
          slug: `${FIXTURE_PREFIX}-neighbour`,
          name: 'Next door',
          status: 'active',
        },
        { id: PENDING_ID, slug: `${FIXTURE_PREFIX}-pending`, name: 'Half made', status: 'pending' },
        { id: RESTORED_ID, slug: `${FIXTURE_PREFIX}-restored`, name: 'Back', status: 'active' },
      ],
    });
    await systemPrisma.contact.createMany({
      data: [
        { id: CONTACT_OF.deactivated, tenantId: DEACTIVATED_ID, phoneE164: '+10000005101' },
        { id: CONTACT_OF.neighbour, tenantId: NEIGHBOUR_ID, phoneE164: '+10000005102' },
        { id: CONTACT_OF.pending, tenantId: PENDING_ID, phoneE164: '+10000005103' },
        { id: CONTACT_OF.restored, tenantId: RESTORED_ID, phoneE164: '+10000005104' },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  describe('what deactivation writes', () => {
    it('suspends the tenant, stamps it, and touches nothing else', async () => {
      // Access before, so the refusals below are the deactivation and not a
      // broken fixture.
      const before = await asTenant(DEACTIVATED_ID, () =>
        tenantPrisma.contact.findMany({ select: { id: true } }),
      );
      expect(before).toEqual([{ id: CONTACT_OF.deactivated }]);

      const { tenant, deactivated } = await deactivation.deactivate({
        slug: `${FIXTURE_PREFIX}-deactivated`,
        reason: 'TAR-51 integration test',
      });

      expect(deactivated).toBe(true);
      expect(tenant.status).toBe('suspended');
      expect(tenant.suspendedAt).toBeInstanceOf(Date);
    });

    it('records the revocation in the tenant’s own audit trail', async () => {
      const entries = await systemPrisma.auditLog.findMany({
        where: { tenantId: DEACTIVATED_ID, action: TENANT_DEACTIVATED_ACTION },
        select: { actorUserId: true, targetType: true, targetId: true, metadata: true },
      });

      expect(entries).toEqual([
        {
          // The platform acted, not a user inside the tenant.
          actorUserId: null,
          targetType: 'tenant',
          targetId: DEACTIVATED_ID,
          metadata: { reason: 'TAR-51 integration test' },
        },
      ]);
    });

    it('is idempotent, and does not move the stamp on a repeat', async () => {
      const first = await systemPrisma.tenant.findUniqueOrThrow({
        where: { id: DEACTIVATED_ID },
        select: { suspendedAt: true },
      });

      const repeat = await deactivation.deactivate({ slug: `${FIXTURE_PREFIX}-deactivated` });

      expect(repeat.deactivated).toBe(false);
      // The stamp records when access was actually revoked. A replayed script
      // must not rewrite that.
      expect(repeat.tenant.suspendedAt).toEqual(first.suspendedAt);
    });
  });

  describe('the deactivated tenant reaches nothing', () => {
    it('refuses a read', async () => {
      await asTenant(DEACTIVATED_ID, async () => {
        await expect(tenantPrisma.contact.findMany()).rejects.toBeInstanceOf(TenantNotActiveError);
      });
    });

    it('refuses a write', async () => {
      await asTenant(DEACTIVATED_ID, async () => {
        await expect(
          tenantPrisma.contact.create({
            data: { tenantId: DEACTIVATED_ID, phoneE164: '+10000005199' },
          }),
        ).rejects.toBeInstanceOf(TenantNotActiveError);
      });

      const planted = await systemPrisma.contact.findMany({
        where: { phoneE164: '+10000005199' },
        select: { id: true },
      });
      expect(planted).toHaveLength(0);
    });

    it('refuses raw SQL, which no argument-rewriting extension could reach', async () => {
      await asTenant(DEACTIVATED_ID, async () => {
        await expect(tenantPrisma.$queryRaw`SELECT count(*) FROM contacts`).rejects.toBeInstanceOf(
          TenantNotActiveError,
        );
      });
    });

    it('refuses a transaction, and every statement inside it', async () => {
      await asTenant(DEACTIVATED_ID, async () => {
        await expect(
          tenantPrisma.$tenantTransaction(async (tx) => tx.contact.findMany()),
        ).rejects.toBeInstanceOf(TenantNotActiveError);
      });
    });

    it('cannot even read its own tenant record', async () => {
      await asTenant(DEACTIVATED_ID, async () => {
        await expect(tenantPrisma.tenant.findMany()).rejects.toBeInstanceOf(TenantNotActiveError);
      });
    });

    it('names the tenant it refused, so the log line locates it', async () => {
      const error = await asTenant(DEACTIVATED_ID, () =>
        tenantPrisma.contact.findMany().catch((e: unknown) => e),
      );

      expect((error as TenantNotActiveError).tenantId).toBe(DEACTIVATED_ID);
    });

    it('refuses a tenant that never finished provisioning, for the same reason', async () => {
      // The gate admits `active` and nothing else, so a half-provisioned tenant
      // is closed by the same mechanism rather than by a second rule.
      await asTenant(PENDING_ID, async () => {
        await expect(tenantPrisma.contact.findMany()).rejects.toBeInstanceOf(TenantNotActiveError);
      });
    });
  });

  describe('the data is retained', () => {
    it('leaves every row where it was, reachable by the platform', async () => {
      const [tenant, contacts] = await Promise.all([
        systemPrisma.tenant.findUniqueOrThrow({
          where: { id: DEACTIVATED_ID },
          select: { status: true, name: true },
        }),
        systemPrisma.contact.findMany({
          where: { tenantId: DEACTIVATED_ID },
          select: { id: true },
        }),
      ]);

      expect(tenant).toEqual({ status: 'suspended', name: 'Off' });
      expect(contacts).toEqual([{ id: CONTACT_OF.deactivated }]);
    });

    it('gives it all back the moment the tenant is active again', async () => {
      // Deactivation hides data; it does not destroy it. Reactivation is
      // TAR-36's flow, so the status is put back here the way that flow will —
      // and the point of the assertion is that nothing else had to happen for
      // the rows to be reachable again.
      await deactivation.deactivate({ slug: `${FIXTURE_PREFIX}-restored` });

      await asTenant(RESTORED_ID, async () => {
        await expect(tenantPrisma.contact.findMany()).rejects.toBeInstanceOf(TenantNotActiveError);
      });

      await systemPrisma.tenant.update({
        where: { id: RESTORED_ID },
        data: { status: 'active', suspendedAt: null },
      });

      const restored = await asTenant(RESTORED_ID, () =>
        tenantPrisma.contact.findMany({ select: { id: true } }),
      );

      expect(restored).toEqual([{ id: CONTACT_OF.restored }]);
    });
  });

  describe('the neighbouring tenant is unaffected', () => {
    it('still reads its own rows', async () => {
      const rows = await asTenant(NEIGHBOUR_ID, () =>
        tenantPrisma.contact.findMany({ select: { id: true } }),
      );

      expect(rows).toEqual([{ id: CONTACT_OF.neighbour }]);
    });

    it('still writes, and still sees only itself', async () => {
      const created = await asTenant(NEIGHBOUR_ID, () =>
        tenantPrisma.contact.create({
          data: { tenantId: NEIGHBOUR_ID, phoneE164: '+10000005198' },
          select: { id: true },
        }),
      );

      const visible = await asTenant(NEIGHBOUR_ID, () =>
        tenantPrisma.contact.findMany({ select: { tenantId: true } }),
      );

      expect(visible.map((row) => row.tenantId)).toEqual([NEIGHBOUR_ID, NEIGHBOUR_ID]);

      await asTenant(NEIGHBOUR_ID, () =>
        tenantPrisma.contact.delete({ where: { id: created.id } }),
      );
    });

    it('still runs transactions and raw SQL', async () => {
      const rows = await asTenant(NEIGHBOUR_ID, () =>
        tenantPrisma.$tenantTransaction(
          async (tx) => tx.$queryRaw<{ tenant_id: string }[]>`SELECT tenant_id FROM contacts`,
        ),
      );

      expect(rows).toEqual([{ tenant_id: NEIGHBOUR_ID }]);
    });

    it('is not reachable from the deactivated tenant either', async () => {
      // The neighbour's rows do not become visible to a tenant that has lost
      // its own: the refusal is before the GUC, so nothing is in scope at all.
      await asTenant(DEACTIVATED_ID, async () => {
        await expect(
          tenantPrisma.contact.findUnique({ where: { id: CONTACT_OF.neighbour } }),
        ).rejects.toBeInstanceOf(TenantNotActiveError);
      });

      const survivor = await systemPrisma.contact.findUniqueOrThrow({
        where: { id: CONTACT_OF.neighbour },
        select: { tenantId: true },
      });
      expect(survivor.tenantId).toBe(NEIGHBOUR_ID);
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
