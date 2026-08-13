import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * TAR-285: the shape `assignment_rules` has to hold for TAR-24's routing rules,
 * against a real PostgreSQL as `whatsappcrm_app`.
 *
 * Two of the four schema deltas in
 * `docs/architecture/0007-routing-rules-and-assignment-fallback.md` are
 * invisible to the rest of the toolchain, which is why this file exists:
 *
 *   * **`assignment_rules_active_has_one_target` is a CHECK constraint**, and
 *     Prisma's schema language cannot express one. Its describer does not
 *     report one either, so `migrate dev` proposes neither to create nor to
 *     drop it — nothing regenerates it from `schema.prisma` and nothing notices
 *     if it disappears. Same arrangement, and the same reasoning, as
 *     `tickets_one_active_per_contact` (TAR-74).
 *   * **`name` being `citext` is what makes `UNIQUE (tenant_id, name)`
 *     case-insensitive.** The unique index survives a revert of the column type
 *     and goes on passing every test that only inserts one spelling, while
 *     quietly admitting the pair 0007 added it to prevent.
 *
 * So the assertions here are half catalog and half behaviour, deliberately: the
 * catalog half names the regression, the behaviour half proves the guarantee.
 * A definition asserted by name alone would pass against a constraint whose
 * body had been widened.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids and a `tar285-fixture` marker, deleted before the run as
 * well as after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '85285285-2852-7852-8852-285285285a01';
const TENANT_B = '85285285-2852-7852-8852-285285285b01';

const AGENT_A = '85285285-2852-7852-8852-285285285a02';
const AGENT_B = '85285285-2852-7852-8852-285285285b02';
const TEAM_A = '85285285-2852-7852-8852-285285285a03';
const TEAM_B = '85285285-2852-7852-8852-285285285b03';

const REQUEST_ID = 'tar285-int-spec';

/** Any well-formed member of `RoutingConditionSchema`; the grammar is TAR-288's. */
const CONDITIONS = [{ type: 'keyword', match: 'any', values: ['billing'] }];

let nextRuleId = 0;

/** Fixture ids that stay inside the tenant's prefix, so cleanup catches them. */
function ruleId(): string {
  nextRuleId += 1;

  return `85285285-2852-7852-8852-2852852${String(nextRuleId).padStart(5, '0')}`;
}

describe('assignment rule schema', () => {
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

  async function removeFixture(): Promise<void> {
    // assignment_rules, users and teams all cascade from the tenant, so one
    // delete is enough and stays correct as the schema grows.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar285-fixture-a', name: 'TAR-285 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar285-fixture-b', name: 'TAR-285 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.user.createMany({
      data: [
        {
          id: AGENT_A,
          tenantId: TENANT_A,
          email: 'agent@tar285-fixture-a.invalid',
          name: 'tar285-fixture A agent',
          role: 'agent',
          status: 'active',
        },
        {
          id: AGENT_B,
          tenantId: TENANT_B,
          email: 'agent@tar285-fixture-b.invalid',
          name: 'tar285-fixture B agent',
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

  beforeEach(async () => {
    await systemPrisma.assignmentRule.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
  });

  describe('the catalog', () => {
    it('stores the rule name as citext, and nothing named action survives', async () => {
      const columns = await systemPrisma.$queryRaw<{ column_name: string; udt_name: string }[]>`
        SELECT column_name, udt_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'assignment_rules'
      `;
      const byName = new Map(columns.map((column) => [column.column_name, column.udt_name]));

      // `text` here and the unique index below still passes every single-spelling
      // insert while admitting the pair delta 1 exists to prevent.
      expect(byName.get('name')).toBe('citext');
      // Delta 3. Two representations of one fact is a drift surface with no
      // owner; the target is `target_user_id` / `target_team_id`.
      expect(byName.has('action')).toBe(false);
    });

    it('keeps a unique index on (tenant_id, name) and an ordering index that ends in id', async () => {
      const indexes = await systemPrisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'assignment_rules'
      `;
      const byName = new Map(indexes.map((index) => [index.indexname, index.indexdef]));

      const unique = byName.get('assignment_rules_tenant_id_name_key');
      expect(unique).toContain('CREATE UNIQUE INDEX');
      // `tenant_id` leads, so a conflict can never be caused by another
      // tenant's row — a unique index is not RLS-aware (conventions, rule 3).
      expect(unique).toContain('(tenant_id, name)');

      // Delta 4. `position` defaults to 0 and is not unique, so without `id` in
      // the index two rules created normally need a sort step to order at all.
      expect(byName.get('assignment_rules_tenant_id_is_active_position_id_idx')).toContain(
        '(tenant_id, is_active, "position", id)',
      );
      // Replaced, not added: the three-column form is a strict prefix of the
      // new one, so keeping it would cost writes to serve nothing.
      expect(byName.has('assignment_rules_tenant_id_is_active_position_idx')).toBe(false);
    });

    it('carries the one-target CHECK, still conditional on is_active', async () => {
      // Asserting the body rather than the name: a constraint quietly widened —
      // or made unconditional, which would break user removal — passes a
      // name-only check and fails the users.service.ts case below.
      const [constraint] = await systemPrisma.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'public.assignment_rules'::regclass
          AND conname = 'assignment_rules_active_has_one_target'
      `;

      // Postgres renders it back with its own parenthesisation, so this asserts
      // the two halves rather than the literal text of the migration.
      expect(constraint?.definition).toContain('(NOT is_active) OR');
      expect(constraint?.definition).toContain('num_nonnulls(target_user_id, target_team_id) = 1');
    });

    it('still has row-level security, which delta 5 says this migration must not touch', async () => {
      const [table] = await systemPrisma.$queryRaw<{ enabled: boolean; forced: boolean }[]>`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = 'public.assignment_rules'::regclass
      `;

      expect(table).toEqual({ enabled: true, forced: true });

      const policies = await systemPrisma.$queryRaw<{ policyname: string }[]>`
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'assignment_rules'
      `;

      expect(policies.map((policy) => policy.policyname)).toContain('tenant_isolation');
    });
  });

  describe('rule names', () => {
    it('refuses a second rule whose name differs only by case', async () => {
      await systemPrisma.assignmentRule.create({
        data: {
          id: ruleId(),
          tenantId: TENANT_A,
          name: 'Billing',
          conditions: CONDITIONS,
          targetTeamId: TEAM_A,
        },
      });

      // The rule name is what an audit reader sees in the ticket event that
      // records why a ticket was routed. `Billing` beside `billing` there is
      // two rules nobody can tell apart (0007, delta 1).
      await expect(
        systemPrisma.assignmentRule.create({
          data: {
            id: ruleId(),
            tenantId: TENANT_A,
            name: 'billing',
            conditions: CONDITIONS,
            targetTeamId: TEAM_A,
          },
        }),
      ).rejects.toThrow();
    });

    it('lets two tenants each hold a rule of the same name', async () => {
      // What the index must NOT constrain. `tenant_id` leads it for exactly
      // this reason.
      await systemPrisma.assignmentRule.createMany({
        data: [
          {
            id: ruleId(),
            tenantId: TENANT_A,
            name: 'Billing',
            conditions: CONDITIONS,
            targetTeamId: TEAM_A,
          },
          {
            id: ruleId(),
            tenantId: TENANT_B,
            name: 'Billing',
            conditions: CONDITIONS,
            targetTeamId: TEAM_B,
          },
        ],
      });

      expect(
        await systemPrisma.assignmentRule.count({
          where: { tenantId: { in: [TENANT_A, TENANT_B] } },
        }),
      ).toBe(2);
    });

    it('finds a rule by a spelling nobody typed', async () => {
      // The other half of citext, and the one the console depends on: a
      // supervisor searching "billing" finds the rule they called "Billing".
      await systemPrisma.assignmentRule.create({
        data: {
          id: ruleId(),
          tenantId: TENANT_A,
          name: 'Billing',
          conditions: CONDITIONS,
          targetTeamId: TEAM_A,
        },
      });

      const found = await systemPrisma.assignmentRule.findFirst({
        where: { tenantId: TENANT_A, name: 'BILLING' },
        select: { name: true },
      });

      expect(found?.name).toBe('Billing');
    });
  });

  describe('an active rule has exactly one target', () => {
    it.each([
      ['a team', { targetTeamId: TEAM_A }],
      ['a user', { targetUserId: AGENT_A }],
    ])('accepts one targeting %s', async (_label, target) => {
      await expect(
        systemPrisma.assignmentRule.create({
          data: {
            id: ruleId(),
            tenantId: TENANT_A,
            name: `active with ${_label}`,
            conditions: CONDITIONS,
            ...target,
          },
        }),
      ).resolves.toMatchObject({ isActive: true });
    });

    it('refuses one with both targets set', async () => {
      // Two destinations is no destination: the engine reads both columns and
      // has no rule for choosing between them.
      await expect(
        systemPrisma.assignmentRule.create({
          data: {
            id: ruleId(),
            tenantId: TENANT_A,
            name: 'both targets',
            conditions: CONDITIONS,
            targetTeamId: TEAM_A,
            targetUserId: AGENT_A,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses one with neither', async () => {
      await expect(
        systemPrisma.assignmentRule.create({
          data: {
            id: ruleId(),
            tenantId: TENANT_A,
            name: 'no target',
            conditions: CONDITIONS,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses to re-enable a rule that has no target', async () => {
      // The constraint covers UPDATE as well as INSERT, which is the half an
      // application-level check on the create path would miss. TAR-288 turns
      // this into `validation_failed` so a supervisor is told what is missing
      // rather than shown a constraint violation.
      const orphan = await systemPrisma.assignmentRule.create({
        data: {
          id: ruleId(),
          tenantId: TENANT_A,
          name: 'orphaned',
          conditions: CONDITIONS,
          isActive: false,
        },
      });

      await expect(
        systemPrisma.assignmentRule.update({ where: { id: orphan.id }, data: { isActive: true } }),
      ).rejects.toThrow();
    });
  });

  describe('the inactive orphan, which is a state the shipped code creates', () => {
    it('allows an inactive rule with no target at all', async () => {
      await expect(
        systemPrisma.assignmentRule.create({
          data: {
            id: ruleId(),
            tenantId: TENANT_A,
            name: 'inactive orphan',
            conditions: CONDITIONS,
            isActive: false,
          },
        }),
      ).resolves.toMatchObject({ targetUserId: null, targetTeamId: null });
    });

    it('survives the statement users.service.ts runs when a target user is removed', async () => {
      // Verbatim from `UsersService`, and the reason the CHECK is conditional
      // on `is_active`: an unconditional `num_nonnulls(...) = 1` would make this
      // fail at the constraint and break user removal outright.
      const rule = await systemPrisma.assignmentRule.create({
        data: {
          id: ruleId(),
          tenantId: TENANT_A,
          name: 'routes to the leaver',
          conditions: CONDITIONS,
          targetUserId: AGENT_A,
        },
      });

      await expect(
        systemPrisma.assignmentRule.updateMany({
          where: { targetUserId: AGENT_A },
          data: { targetUserId: null, isActive: false },
        }),
      ).resolves.toEqual({ count: 1 });

      // Deactivated rather than deleted: a supervisor should find the rule
      // needing a new target, not find it silently gone.
      expect(
        await systemPrisma.assignmentRule.findUnique({ where: { id: rule.id } }),
      ).toMatchObject({ isActive: false, targetUserId: null });
    });
  });

  describe('through the app role, under RLS', () => {
    it('shows a tenant only its own rules', async () => {
      await systemPrisma.assignmentRule.createMany({
        data: [
          {
            id: ruleId(),
            tenantId: TENANT_A,
            name: 'A rule',
            conditions: CONDITIONS,
            targetTeamId: TEAM_A,
          },
          {
            id: ruleId(),
            tenantId: TENANT_B,
            name: 'B rule',
            conditions: CONDITIONS,
            targetTeamId: TEAM_B,
          },
        ],
      });

      const seen = await asTenant(TENANT_A, () =>
        tenantPrisma.assignmentRule.findMany({ select: { tenantId: true } }),
      );

      expect(seen).toEqual([{ tenantId: TENANT_A }]);
    });

    it('matches no rows when one tenant tries to disable another tenant’s rule', async () => {
      const foreign = await systemPrisma.assignmentRule.create({
        data: {
          id: ruleId(),
          tenantId: TENANT_B,
          name: 'B rule',
          conditions: CONDITIONS,
          targetTeamId: TEAM_B,
        },
      });

      const disabled = await asTenant(TENANT_A, () =>
        tenantPrisma.assignmentRule.updateMany({
          where: { id: foreign.id },
          data: { isActive: false },
        }),
      );

      expect(disabled.count).toBe(0);
      expect(
        await systemPrisma.assignmentRule.findUnique({ where: { id: foreign.id } }),
      ).toMatchObject({ isActive: true });
    });

    it.each([
      ['team', (): object => ({ targetTeamId: TEAM_B })],
      ['user', (): object => ({ targetUserId: AGENT_B })],
    ])('refuses to route work at another tenant’s %s', async (_label, target) => {
      // The row carries tenant A's own tenant_id, so the RLS WITH CHECK is
      // satisfied and the policy has nothing to say. The composite foreign key
      // to `(tenant_id, id)` is what rejects it — the difference between
      // "invisible" and "cannot be referenced" (0007, security and access).
      await asTenant(TENANT_A, async () => {
        await expect(
          tenantPrisma.assignmentRule.create({
            data: {
              id: ruleId(),
              tenantId: TENANT_A,
              name: `steals a ${_label}`,
              conditions: CONDITIONS,
              ...target(),
            },
          }),
        ).rejects.toThrow();
      });

      expect(await systemPrisma.assignmentRule.count({ where: { tenantId: TENANT_A } })).toBe(0);
    });
  });

  describe('the ordering the engine reads', () => {
    it('is total: equal positions fall back to creation order', async () => {
      // Not a property of the index — a property of `ORDER BY position, id`
      // being able to resolve what `position` alone cannot. Both rules are
      // created with the default position of 0, which is what a supervisor
      // adding two rules and reordering neither produces.
      const first = ruleId();
      const second = ruleId();

      await systemPrisma.assignmentRule.create({
        data: {
          id: first,
          tenantId: TENANT_A,
          name: 'first',
          conditions: CONDITIONS,
          targetTeamId: TEAM_A,
        },
      });
      await systemPrisma.assignmentRule.create({
        data: {
          id: second,
          tenantId: TENANT_A,
          name: 'second',
          conditions: CONDITIONS,
          targetTeamId: TEAM_A,
        },
      });

      const ordered = await asTenant(TENANT_A, () =>
        tenantPrisma.assignmentRule.findMany({
          where: { isActive: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          select: { id: true, position: true },
        }),
      );

      expect(ordered.map((rule) => rule.position)).toEqual([0, 0]);
      expect(ordered.map((rule) => rule.id)).toEqual([first, second].sort());
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
