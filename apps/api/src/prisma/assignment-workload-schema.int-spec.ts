import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * TAR-272: the parts of the assignment-workload schema that `schema.prisma`
 * cannot express, against a real PostgreSQL.
 *
 * Everything else in
 * `20260813150000_assignment_workload_and_routing_state` is an ordinary column
 * and Prisma will tell you loudly if it drifts. These four will not tell you
 * anything:
 *
 *   1. `tickets_routing_deferred_idx` — partial. Prisma's describer skips
 *      indexes carrying a predicate, so `migrate dev` proposes neither to create
 *      nor to drop it.
 *   2. `tickets_routing_deferred_consistent` — a CHECK. Prisma's schema language
 *      has none, and its describer ignores them.
 *   3. The two workload-cap range CHECKs, for the same reason.
 *   4. **`NULLS NOT DISTINCT` on `assignment_state_tenant_scope_key`.** The
 *      worst of the four. Prisma sees a unique index on `(tenant_id, team_id)`,
 *      matches `@@unique` against it and reports no drift — so a future
 *      `migrate dev` that recreates the index for any unrelated reason
 *      recreates it NULL-distinct, and a tenant can then hold several
 *      tenant-pool rotation cursors. Nothing fails at that point. Rotation
 *      reads a different cursor each time and quietly stops rotating, which is
 *      TAR-23's whole feature silently not working.
 *
 * Each is asserted twice over: once on its catalogue definition, so a narrowed
 * predicate or a dropped `NULLS NOT DISTINCT` is caught by name, and once
 * behaviourally, so an assertion that passes against a definition which no
 * longer means what it says still fails. `ticket-active-uniqueness.int-spec.ts`
 * is the worked example this follows.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. One fixture tenant
 * carrying a fixed id and a `tar272-fixture` slug, deleted before the run as
 * well as after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT = '27222222-2222-7222-8222-222222222201';
/**
 * A second, genuinely active tenant. It has to exist rather than be a made-up
 * id: TAR-51's deactivation gate refuses an unknown tenant before RLS is ever
 * consulted, so reading as a fictional one would pass the isolation case
 * without testing isolation.
 */
const OTHER_TENANT = '27222222-2222-7222-8222-222222222202';
const TEAM = '27222222-2222-7222-8222-2222222222a0';
const OTHER_TEAM = '27222222-2222-7222-8222-2222222222a1';
const AGENT = '27222222-2222-7222-8222-2222222222b0';
const CONTACT = '27222222-2222-7222-8222-2222222222c0';

const REQUEST_ID = 'tar272-int-spec';

/** Asserts a single row and hands it back — `noUncheckedIndexedAccess` is on. */
function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);

  const [row] = rows;

  if (row === undefined) {
    throw new Error('unreachable: the length assertion above would have failed first');
  }

  return row;
}

describe('assignment workload schema', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

  /** Next free ticket number, so cases can be added without renumbering. */
  let nextNumber = 27_200;

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
   * Raw, because the three routing columns have to be written in shapes the
   * Prisma client would refuse to construct — that is the point of the CHECK.
   */
  function createTicket(
    routingState: string,
    reason: string | null,
    since: Date | null,
  ): Promise<unknown> {
    return systemPrisma.$executeRaw`
      INSERT INTO tickets (id, tenant_id, number, status, contact_id,
                           routing_state, routing_deferred_reason, routing_deferred_since,
                           created_at, updated_at)
      VALUES (gen_random_uuid(), ${TENANT}::uuid, ${(nextNumber += 1)}, 'open', ${CONTACT}::uuid,
              ${routingState}::ticket_routing_state,
              ${reason}::ticket_routing_deferred_reason,
              ${since}::timestamptz,
              now(), now())
    `;
  }

  /**
   * The fixture tenant's settings row, created on first use and left at the
   * column default. Idempotent, so no case depends on another having run.
   */
  function settingsRow(): Promise<{ defaultMaxConcurrentTickets: number }> {
    return systemPrisma.tenantSettings.upsert({
      where: { tenantId: TENANT },
      create: { tenantId: TENANT },
      update: {},
      select: { defaultMaxConcurrentTickets: true },
    });
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
        { id: TENANT, slug: 'tar272-fixture', name: 'TAR-272 fixture', status: 'active' },
        { id: OTHER_TENANT, slug: 'tar272-fixture-b', name: 'TAR-272 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.team.createMany({
      data: [
        { id: TEAM, tenantId: TENANT, name: 'TAR-272 support' },
        { id: OTHER_TEAM, tenantId: TENANT, name: 'TAR-272 billing' },
      ],
    });
    await systemPrisma.user.create({
      data: {
        id: AGENT,
        tenantId: TENANT,
        email: 'tar272-agent@fixture.test',
        name: 'TAR-272 agent',
        role: 'agent',
        status: 'active',
      },
    });
    await systemPrisma.contact.create({
      data: { id: CONTACT, tenantId: TENANT, phoneE164: '+10000027201' },
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    await systemPrisma.assignmentState.deleteMany({ where: { tenantId: TENANT } });
    await systemPrisma.ticket.deleteMany({ where: { tenantId: TENANT } });
    // Cleared too, so `settingsRow()` genuinely re-reads the column default
    // rather than whatever an earlier case left behind.
    await systemPrisma.tenantSettings.deleteMany({ where: { tenantId: TENANT } });
  });

  describe('the rotation cursor admits the tenant pool', () => {
    it('is unique NULLS NOT DISTINCT, not merely unique', async () => {
      const index = only(await indexDefinition('assignment_state_tenant_scope_key'));

      expect(index.indexdef).toContain('CREATE UNIQUE INDEX');
      expect(index.indexdef).toContain('(tenant_id, team_id)');
      // The assertion this whole file exists for. Dropping these three words
      // breaks nothing that fails — see the header.
      expect(index.indexdef).toContain('NULLS NOT DISTINCT');
    });

    it('no longer carries the single-column unique on team_id', async () => {
      // Redundant with the composite while `team_id` was NOT NULL, and wrong
      // once it is nullable: it would constrain the pool cursor by accident of
      // NULL semantics rather than by design.
      expect(await indexDefinition('assignment_state_team_id_key')).toHaveLength(0);
    });

    it('lets one tenant hold a cursor per team and one for the pool', async () => {
      await systemPrisma.assignmentState.createMany({
        data: [
          { tenantId: TENANT, teamId: TEAM },
          { tenantId: TENANT, teamId: OTHER_TEAM },
          { tenantId: TENANT, teamId: null },
        ],
      });

      expect(await systemPrisma.assignmentState.count({ where: { tenantId: TENANT } })).toBe(3);
    });

    it('refuses a second tenant-pool cursor', async () => {
      // Behavioural half of the first case. Without `NULLS NOT DISTINCT` this
      // insert succeeds, nothing reports an error, and rotation silently reads
      // an arbitrary one of the two from then on.
      await systemPrisma.assignmentState.create({ data: { tenantId: TENANT, teamId: null } });

      await expect(
        systemPrisma.assignmentState.create({ data: { tenantId: TENANT, teamId: null } }),
      ).rejects.toThrow();
    });
  });

  describe('the deferred flag and its reason cannot disagree', () => {
    it('is enforced by a CHECK in both directions', async () => {
      const check = only(await checkDefinition('tickets_routing_deferred_consistent'));

      expect(check.definition).toContain('routing_deferred_reason IS NOT NULL');
      expect(check.definition).toContain('routing_deferred_since IS NOT NULL');
    });

    it.each([
      ['deferred with neither column set', 'deferred', null, false],
      ['deferred with a reason but no since', 'deferred', 'all_at_capacity', false],
      ['deferred with a since but no reason', 'deferred', null, true],
      ['assigned but still carrying a reason', 'assigned', 'none_available', false],
      ['assigned but still carrying a since', 'assigned', null, true],
    ] as const)('rejects a ticket %s', async (_case, state, reason, since) => {
      // All four asymmetries, so both conjuncts of the CHECK are exercised in
      // both directions. A deferred ticket missing either column renders an
      // empty cell in TAR-274's view; a non-deferred one still carrying either
      // renders a stale explanation on a ticket that is fine. Neither fails
      // anywhere else, which is what makes them worth a constraint.
      //
      // Asserting the constraint name, not merely that something threw: a NOT
      // NULL violation or a missing fixture row would satisfy a bare
      // `.rejects.toThrow()` just as well and the case would still be green.
      await expect(createTicket(state, reason, since ? new Date() : null)).rejects.toThrow(
        /tickets_routing_deferred_consistent/,
      );
    });

    it('accepts the complete deferred triple', async () => {
      await expect(
        createTicket('deferred', 'all_at_capacity', new Date()),
      ).resolves.toBeGreaterThan(0);
    });

    it('defaults a new ticket to pending with both columns null', async () => {
      // The column default is what keeps every existing create path working
      // without a change — no writer sets `routing_state` until TAR-273.
      const created = await systemPrisma.ticket.create({
        data: { tenantId: TENANT, number: (nextNumber += 1), contactId: CONTACT },
        select: { routingState: true, routingDeferredReason: true, routingDeferredSince: true },
      });

      expect(created).toEqual({
        routingState: 'pending',
        routingDeferredReason: null,
        routingDeferredSince: null,
      });
    });
  });

  describe('the supervisor’s deferred list', () => {
    it('has a partial index holding only the deferred set', async () => {
      const index = only(await indexDefinition('tickets_routing_deferred_idx'));

      // Asserting the definition rather than the name: a predicate quietly
      // widened to every ticket turns a small index into one the size of the
      // table, and it would pass a name-only check.
      expect(index.indexdef).toContain('(tenant_id, routing_deferred_since)');
      expect(index.indexdef).toMatch(/WHERE \(routing_state = 'deferred'/);
    });
  });

  describe('the workload cap', () => {
    it('bounds a per-agent override, and lets it be null', async () => {
      const check = only(await checkDefinition('users_max_concurrent_tickets_range'));
      expect(check.definition).toContain('max_concurrent_tickets IS NULL');

      // Null means inherit the tenant default — not "no cap" and not zero.
      await expect(
        systemPrisma.user.update({ where: { id: AGENT }, data: { maxConcurrentTickets: null } }),
      ).resolves.toBeDefined();
      await expect(
        systemPrisma.user.update({ where: { id: AGENT }, data: { maxConcurrentTickets: 7 } }),
      ).resolves.toBeDefined();
    });

    it.each([0, -1, 1001])('refuses a per-agent cap of %s', async (cap) => {
      // The floor is 1: "route nothing to me" is what `availability = 'away'`
      // already means, and a second way to say it is a second thing to keep in
      // step.
      await expect(
        systemPrisma.user.update({ where: { id: AGENT }, data: { maxConcurrentTickets: cap } }),
      ).rejects.toThrow(/users_max_concurrent_tickets_range/);
    });

    it('gives a tenant a working default with nothing configured', async () => {
      // TAR-50's provisioning writes no cap, so the column default is what makes
      // routing work for a brand-new tenant. `ASSIGNMENT_POLICY` has to agree
      // with this number.
      const settings = await settingsRow();

      expect(settings.defaultMaxConcurrentTickets).toBe(5);
    });

    it.each([0, 1001])('refuses a tenant default of %s', async (cap) => {
      await expect(
        checkDefinition('tenant_settings_default_max_concurrent_tickets_range'),
      ).resolves.toHaveLength(1);

      // Upserted here rather than leaning on the previous case having created
      // it. Prisma raises P2025 when the row is absent, which satisfies a bare
      // `.rejects.toThrow()` exactly as a constraint violation would — so run
      // alone, or after a failure above, this case would have gone green
      // without the CHECK existing at all. Matching the constraint name closes
      // the same hole from the other side.
      await settingsRow();

      await expect(
        systemPrisma.tenantSettings.update({
          where: { tenantId: TENANT },
          data: { defaultMaxConcurrentTickets: cap },
        }),
      ).rejects.toThrow(/tenant_settings_default_max_concurrent_tickets_range/);
    });
  });

  describe('through the app role, under RLS', () => {
    it('keeps the new columns inside the tenant boundary', async () => {
      // No new table, so no new policy — the columns inherit `tickets`' own
      // `tenant_isolation`. Asserted rather than assumed: this is the one claim
      // in 0008's security section that a migration could have got wrong by
      // adding a table instead of columns.
      await createTicket('deferred', 'all_at_capacity', new Date());

      const seen = await asTenant(OTHER_TENANT, () =>
        tenantPrisma.ticket.findMany({ where: { routingState: 'deferred' }, select: { id: true } }),
      );

      expect(seen).toHaveLength(0);

      const own = await asTenant(TENANT, () =>
        tenantPrisma.ticket.findMany({ where: { routingState: 'deferred' }, select: { id: true } }),
      );

      expect(own).toHaveLength(1);
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
