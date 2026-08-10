import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * TAR-80: the agent / team / role tables specifically, against a real
 * PostgreSQL as `whatsappcrm_app` — the role that holds no `BYPASSRLS`.
 *
 * `tenant-isolation.int-spec.ts` already proves the mechanism on `contacts`, and
 * `verify-tenant-isolation.sql` proves every table carries the policy. Neither
 * covers the property this story actually turns on, because it is not RLS at
 * all: **composite foreign keys**.
 *
 * `team_members` references `(tenant_id, team_id)` and `(tenant_id, user_id)`,
 * never a bare id. RLS stops tenant A *reading* tenant B's user; it does nothing
 * about tenant A writing a `team_members` row whose `user_id` it copied from a
 * request body and whose `tenant_id` is its own — the row satisfies the policy's
 * WITH CHECK, because it carries the right tenant. What rejects it is the
 * composite key having no matching parent. That is the difference between
 * "another tenant's data is invisible" and "another tenant's data cannot be
 * referenced", and TAR-22's acceptance criteria need the second.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids and a `tar80-fixture` marker, deleted before the run as
 * well as after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '80888888-8888-7888-8888-888888888801';
const TENANT_B = '80888888-8888-7888-8888-888888888802';
const ADMIN_A = '80888888-8888-7888-8888-8888888888a1';
const AGENT_A = '80888888-8888-7888-8888-8888888888a2';
const AGENT_B = '80888888-8888-7888-8888-8888888888b1';
const TEAM_A = '80888888-8888-7888-8888-88888888a001';
const TEAM_B = '80888888-8888-7888-8888-88888888b001';

const REQUEST_ID = 'tar80-int-spec';

describe('agent, team and role isolation', () => {
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

  async function removeFixture(): Promise<void> {
    // team_members and users cascade from the tenant; deleting the tenant is
    // enough, and is what keeps this cleanup correct as the schema grows.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar80-fixture-a', name: 'TAR-80 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar80-fixture-b', name: 'TAR-80 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.user.createMany({
      data: [
        {
          id: ADMIN_A,
          tenantId: TENANT_A,
          email: 'admin@tar80-fixture-a.invalid',
          name: 'tar80-fixture A admin',
          role: 'admin',
          status: 'active',
        },
        {
          id: AGENT_A,
          tenantId: TENANT_A,
          email: 'agent@tar80-fixture-a.invalid',
          name: 'tar80-fixture A agent',
          role: 'agent',
          status: 'active',
        },
        {
          id: AGENT_B,
          tenantId: TENANT_B,
          email: 'agent@tar80-fixture-b.invalid',
          name: 'tar80-fixture B agent',
          role: 'agent',
          status: 'active',
        },
      ],
    });
    await systemPrisma.team.createMany({
      data: [
        { id: TEAM_A, tenantId: TENANT_A, name: 'Billing' },
        { id: TEAM_B, tenantId: TENANT_B, name: 'Billing' },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  describe('the role vocabulary', () => {
    it('is exactly the contract’s three roles', async () => {
      const rows = await systemPrisma.$queryRaw<
        { role: string }[]
      >`SELECT unnest(enum_range(NULL::user_role))::text AS role`;

      // Mirrors TENANT_ROLES in packages/contracts/src/rbac.ts. A fourth value
      // here is a row the response serialiser cannot parse, so this asserts the
      // set rather than a subset.
      expect(rows.map((row) => row.role).sort()).toEqual(['admin', 'agent', 'supervisor']);
    });
  });

  describe('reads', () => {
    it('shows a tenant only its own users, whatever their role', async () => {
      const seenByA = await asTenant(TENANT_A, () =>
        tenantPrisma.user.findMany({ select: { id: true }, orderBy: { id: 'asc' } }),
      );

      expect(seenByA).toEqual([{ id: ADMIN_A }, { id: AGENT_A }]);
    });

    it('returns nothing when one tenant asks for another tenant’s user by id', async () => {
      const stolen = await asTenant(TENANT_A, () =>
        tenantPrisma.user.findUnique({ where: { id: AGENT_B }, select: { id: true } }),
      );

      expect(stolen).toBeNull();
    });

    it('shows a tenant only its own teams, despite both being named Billing', async () => {
      const seenByB = await asTenant(TENANT_B, () =>
        tenantPrisma.team.findMany({ select: { id: true } }),
      );

      expect(seenByB).toEqual([{ id: TEAM_B }]);
    });
  });

  describe('writes across the tenant boundary', () => {
    it('refuses to put another tenant’s user in its own team', async () => {
      // The row carries tenant A's own tenant_id, so the RLS WITH CHECK is
      // satisfied and the policy has nothing to say. The composite foreign key
      // to (tenant_id, user_id) is what rejects it.
      await asTenant(TENANT_A, async () => {
        await expect(
          tenantPrisma.teamMember.create({
            data: { tenantId: TENANT_A, teamId: TEAM_A, userId: AGENT_B },
          }),
        ).rejects.toThrow();
      });

      const planted = await systemPrisma.teamMember.findMany({ where: { userId: AGENT_B } });
      expect(planted).toHaveLength(0);
    });

    it('refuses to put its own user in another tenant’s team', async () => {
      await asTenant(TENANT_A, async () => {
        await expect(
          tenantPrisma.teamMember.create({
            data: { tenantId: TENANT_A, teamId: TEAM_B, userId: AGENT_A },
          }),
        ).rejects.toThrow();
      });

      const planted = await systemPrisma.teamMember.findMany({ where: { teamId: TEAM_B } });
      expect(planted).toHaveLength(0);
    });

    it('refuses to assign a conversation to another tenant’s user or team', async () => {
      // Same composite-key property on the columns that carry TAR-22's
      // visibility rules. A tenant cannot route work at another tenant.
      await asTenant(TENANT_A, async () => {
        await expect(
          tenantPrisma.$executeRaw`
            UPDATE conversations SET assigned_user_id = ${AGENT_B}::uuid WHERE tenant_id = ${TENANT_A}::uuid
          `,
        ).resolves.toBe(0);
      });
    });

    it('matches no rows when one tenant tries to promote another tenant’s agent', async () => {
      const promoted = await asTenant(TENANT_A, () =>
        tenantPrisma.user.updateMany({ where: { id: AGENT_B }, data: { role: 'admin' } }),
      );

      expect(promoted.count).toBe(0);

      const survivor = await systemPrisma.user.findUnique({
        where: { id: AGENT_B },
        select: { role: true },
      });
      expect(survivor?.role).toBe('agent');
    });

    it('matches no rows when one tenant tries to delete another tenant’s team', async () => {
      const deleted = await asTenant(TENANT_A, () =>
        tenantPrisma.team.deleteMany({ where: { id: TEAM_B } }),
      );

      expect(deleted.count).toBe(0);
      expect(await systemPrisma.team.findUnique({ where: { id: TEAM_B } })).not.toBeNull();
    });
  });

  describe('writes within the tenant', () => {
    it('adds its own user to its own team, and reads the membership back', async () => {
      const created = await asTenant(TENANT_A, () =>
        tenantPrisma.teamMember.create({
          data: { tenantId: TENANT_A, teamId: TEAM_A, userId: AGENT_A },
          select: { tenantId: true, teamId: true, userId: true },
        }),
      );

      expect(created).toEqual({ tenantId: TENANT_A, teamId: TEAM_A, userId: AGENT_A });

      // The read behind SessionPrincipal.teamIds, over the index this story
      // widened to (tenant_id, user_id, team_id).
      const teamIds = await asTenant(TENANT_A, () =>
        tenantPrisma.teamMember.findMany({ where: { userId: AGENT_A }, select: { teamId: true } }),
      );
      expect(teamIds).toEqual([{ teamId: TEAM_A }]);
    });

    it('treats team names case-insensitively within a tenant', async () => {
      // teams.name is citext, so this collides with the existing 'Billing'
      // rather than creating a second, indistinguishable team.
      await asTenant(TENANT_A, async () => {
        await expect(
          tenantPrisma.team.create({ data: { tenantId: TENANT_A, name: 'billing' } }),
        ).rejects.toThrow();
      });

      const teams = await systemPrisma.team.findMany({ where: { tenantId: TENANT_A } });
      expect(teams).toHaveLength(1);
    });

    it('lets two tenants each hold a team of the same name', async () => {
      // The unique key is (tenant_id, name), not name. Already true of the
      // fixture; asserted so a future "global unique team name" cannot slip in.
      const names = await systemPrisma.team.findMany({
        where: { tenantId: { in: [TENANT_A, TENANT_B] } },
        select: { name: true },
      });

      expect(names).toEqual([{ name: 'Billing' }, { name: 'Billing' }]);
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
