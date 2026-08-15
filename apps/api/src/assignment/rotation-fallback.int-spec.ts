import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { RotationFallbackResolver } from './rotation-fallback.resolver';

/**
 * TAR-273: the half of rotation that only a real PostgreSQL can prove.
 *
 * `rotation-fallback.resolver.spec.ts` covers the branching with a mocked
 * client, and says plainly what it cannot reach: **the ordering**. Least-loaded
 * first, rotation as the tie-break and `users.id` as the total order is one
 * `ORDER BY` executed by the database, so a mock returning a hand-ordered array
 * would assert nothing but the array. These are 0008's five cases against the
 * statement as it actually runs:
 *
 *   1. Rotation — four equally-loaded agents take one each in ring order, and
 *      the ring wraps.
 *   2. Load limit — an agent at their cap is skipped, and the cursor does not
 *      stall on them.
 *   3. **Load precedence** — a less-loaded agent wins over one earlier in the
 *      ring. 0008 calls this the case most likely to be got wrong, because it is
 *      the only one where the two halves of "round-robin / load-based" disagree.
 *   4. Deferral, all three reasons, including both routes to `none_available`.
 *   5. Tenant isolation — a candidate scan in one tenant never reaches another's
 *      users, even when this tenant has nobody and that one is idle.
 *
 * Two things here are assertions about SQL rather than about TypeScript, and
 * neither survives being moved into the unit suite: that `ON CONFLICT
 * (tenant_id, team_id)` resolves against a `NULLS NOT DISTINCT` index — so the
 * tenant pool keeps **one** cursor rather than growing a row per ticket — and
 * that a null cursor starts the ring at the lowest id rather than matching
 * nothing.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids and `tar273-fixture*` slugs, deleted before the run as well
 * as after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT = '27333333-3333-7333-8333-333333333301';
/**
 * A second, genuinely active tenant. It has to exist rather than be a made-up
 * id: TAR-51's deactivation gate refuses an unknown tenant before RLS is ever
 * consulted, so reading as a fictional one would pass the isolation case
 * without testing isolation.
 */
const OTHER_TENANT = '27333333-3333-7333-8333-333333333302';

const TEAM = '27333333-3333-7333-8333-3333333333a0';
const EMPTY_TEAM = '27333333-3333-7333-8333-3333333333a1';

/**
 * Ascending, and that is load-bearing: ascending `users.id` is the ring order,
 * because ids are uuid v7 and therefore join order. Every ordering expectation
 * below reads against this sequence.
 */
const AGENT_A = '27333333-3333-7333-8333-3333333333b1';
const AGENT_B = '27333333-3333-7333-8333-3333333333b2';
const AGENT_C = '27333333-3333-7333-8333-3333333333b3';
const AGENT_D = '27333333-3333-7333-8333-3333333333b4';
const AGENTS = [AGENT_A, AGENT_B, AGENT_C, AGENT_D];

/** In the tenant, active and available — and deliberately not an `agent`. */
const SUPERVISOR = '27333333-3333-7333-8333-3333333333c0';
/** The other tenant's only agent, idle. Nothing in `TENANT` may ever see them. */
const FOREIGN_AGENT = '27333333-3333-7333-8333-3333333333d0';

const TICKET = '27333333-3333-7333-8333-3333333333e0';
const REQUEST_ID = 'tar273-int-spec';

describe('RotationFallbackResolver against PostgreSQL', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let resolver: RotationFallbackResolver;

  /** Next free ticket number and contact suffix, so cases never collide. */
  let sequence = 27_300;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run({ requestId: REQUEST_ID, tenantId, userId: null }, () => work());
  }

  /** One resolution in the tenant pool, or within a team when one is named. */
  function resolve(teamId: string | null = null, tenantId: string = TENANT) {
    return asTenant(tenantId, () =>
      resolver.resolveFallbackAssignment({
        tenantId,
        ticketId: TICKET,
        contactId: null,
        teamId,
      }),
    );
  }

  /** `count` resolutions in a row, returning who each one picked. */
  async function resolveTimes(count: number, teamId: string | null = null): Promise<unknown[]> {
    const picked: unknown[] = [];

    for (let index = 0; index < count; index += 1) {
      picked.push((await resolve(teamId)).userId);
    }

    return picked;
  }

  /**
   * Gives `userId` `count` active tickets.
   *
   * A fresh contact per ticket, because `tickets_one_active_per_contact` (TAR-74)
   * permits exactly one open or pending ticket per contact — so reusing one
   * would fail on the second insert rather than build the load this is for.
   */
  async function loadAgent(userId: string, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const contactId = await createContact();

      await systemPrisma.ticket.create({
        data: {
          tenantId: TENANT,
          number: (sequence += 1),
          status: 'open',
          contactId,
          assignedUserId: userId,
        },
      });
    }
  }

  async function createContact(): Promise<string> {
    const contact = await systemPrisma.contact.create({
      data: { tenantId: TENANT, phoneE164: `+1000${(sequence += 1)}` },
      select: { id: true },
    });

    return contact.id;
  }

  /** Puts the ring at `userId`, the way a previous assignment would have. */
  function seedCursor(userId: string, teamId: string | null = null): Promise<unknown> {
    return systemPrisma.assignmentState.create({
      data: { tenantId: TENANT, teamId, lastAssignedUserId: userId },
    });
  }

  function cursorFor(
    teamId: string | null = null,
  ): Promise<{ lastAssignedUserId: string | null }[]> {
    return systemPrisma.assignmentState.findMany({
      where: { tenantId: TENANT, teamId },
      select: { lastAssignedUserId: true },
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

    const tenantPrisma: TenantPrisma = withTenantScope(tenantBase, tenantContext);
    resolver = new RotationFallbackResolver(tenantPrisma, tenantContext);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT, slug: 'tar273-fixture', name: 'TAR-273 fixture', status: 'active' },
        { id: OTHER_TENANT, slug: 'tar273-fixture-b', name: 'TAR-273 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.team.createMany({
      data: [
        { id: TEAM, tenantId: TENANT, name: 'TAR-273 support' },
        { id: EMPTY_TEAM, tenantId: TENANT, name: 'TAR-273 nobody' },
      ],
    });
    await systemPrisma.user.createMany({
      data: [
        ...AGENTS.map((id, index) => ({
          id,
          tenantId: TENANT,
          email: `tar273-agent-${index}@fixture.test`,
          name: `TAR-273 agent ${index}`,
          role: 'agent' as const,
          status: 'active' as const,
        })),
        {
          id: SUPERVISOR,
          tenantId: TENANT,
          email: 'tar273-supervisor@fixture.test',
          name: 'TAR-273 supervisor',
          role: 'supervisor',
          status: 'active',
        },
        {
          id: FOREIGN_AGENT,
          tenantId: OTHER_TENANT,
          email: 'tar273-foreign@fixture.test',
          name: 'TAR-273 foreign agent',
          role: 'agent',
          status: 'active',
        },
      ],
    });
    // A and B are in the team; C and D are not. The supervisor is, which is how
    // 0008 says a supervisor who genuinely works a queue joins one.
    await systemPrisma.teamMember.createMany({
      data: [
        { tenantId: TENANT, teamId: TEAM, userId: AGENT_A },
        { tenantId: TENANT, teamId: TEAM, userId: AGENT_B },
        { tenantId: TENANT, teamId: TEAM, userId: SUPERVISOR },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    await systemPrisma.assignmentState.deleteMany({ where: { tenantId: TENANT } });
    await systemPrisma.ticket.deleteMany({ where: { tenantId: TENANT } });
    await systemPrisma.tenantSettings.deleteMany({ where: { tenantId: TENANT } });
    // Everyone back to present, available and uncapped. Each case then breaks
    // exactly the one predicate it is about.
    await systemPrisma.user.updateMany({
      where: { tenantId: { in: [TENANT, OTHER_TENANT] } },
      data: { availability: 'available', lastSeenAt: new Date(), maxConcurrentTickets: null },
    });
  });

  describe('case 1 — rotation', () => {
    it('gives four equally-loaded agents one each, in ring order, then wraps', async () => {
      // No cursor: the `>` comparison is NULL for every row, the coalesce makes
      // it false, the total order applies, and the ring starts at the lowest id.
      // Five resolutions rather than four, because the wrap is the half of
      // round-robin that a cursor-only implementation gets wrong.
      expect(await resolveTimes(5)).toEqual([AGENT_A, AGENT_B, AGENT_C, AGENT_D, AGENT_A]);
    });

    it('resumes after the cursor rather than at the lowest id', async () => {
      await seedCursor(AGENT_C);

      expect(await resolveTimes(3)).toEqual([AGENT_D, AGENT_A, AGENT_B]);
    });

    it('keeps exactly one cursor for the tenant pool', async () => {
      // The `ON CONFLICT (tenant_id, team_id)` upsert has to resolve against
      // `assignment_state_tenant_scope_key`, which is NULLS NOT DISTINCT. If it
      // ever resolves against a NULL-distinct index instead, every resolution
      // inserts a new pool cursor, rotation reads a different one each time and
      // silently stops rotating — which is why this is counted rather than
      // trusted.
      await resolveTimes(4);

      expect(await cursorFor(null)).toEqual([{ lastAssignedUserId: AGENT_D }]);
    });

    it('rotates within a team over its members only', async () => {
      // C and D are not in the team, and the supervisor is — inside a team,
      // membership is the statement of intent and role is not re-checked.
      expect(await resolveTimes(4, TEAM)).toEqual([AGENT_A, AGENT_B, SUPERVISOR, AGENT_A]);
    });

    it('keeps the team cursor separate from the pool cursor', async () => {
      await resolve(TEAM);
      await resolve(null);

      expect(await cursorFor(TEAM)).toEqual([{ lastAssignedUserId: AGENT_A }]);
      expect(await cursorFor(null)).toEqual([{ lastAssignedUserId: AGENT_A }]);
    });
  });

  describe('case 2 — the load limit', () => {
    it('skips an agent at their cap and leaves the cursor on whoever took it', async () => {
      // Everyone carries one ticket, so the load key is a no-op and this is pure
      // rotation. A would be first, and A's cap is 1.
      await Promise.all(AGENTS.map((agent) => loadAgent(agent, 1)));
      await systemPrisma.user.update({
        where: { id: AGENT_A },
        data: { maxConcurrentTickets: 1 },
      });

      const decision = await resolve();

      expect(decision.userId).toBe(AGENT_B);
      // Not A. A cursor that advanced to the agent who was skipped would hand
      // the next ticket to C and quietly cost B a turn every round.
      expect(await cursorFor(null)).toEqual([{ lastAssignedUserId: AGENT_B }]);
    });

    it('inherits the tenant default when the agent has no override', async () => {
      await systemPrisma.tenantSettings.create({
        data: { tenantId: TENANT, defaultMaxConcurrentTickets: 2 },
      });
      await loadAgent(AGENT_A, 2);

      // A is at the tenant default and B is not, but A is also *less* loaded
      // than nobody — the point here is that the cap came from the settings row.
      expect((await resolve()).userId).toBe(AGENT_B);
    });

    it('lets a per-agent override raise the cap above the tenant default', async () => {
      await systemPrisma.tenantSettings.create({
        data: { tenantId: TENANT, defaultMaxConcurrentTickets: 1 },
      });
      await Promise.all(AGENTS.map((agent) => loadAgent(agent, 1)));
      await systemPrisma.user.update({
        where: { id: AGENT_C },
        data: { maxConcurrentTickets: 5 },
      });

      // Everyone is at the tenant cap of 1; only C's override has room.
      expect((await resolve()).userId).toBe(AGENT_C);
    });
  });

  describe('case 3 — load beats rotation', () => {
    it('prefers the least loaded agent over the one next in the ring', async () => {
      // The ring says D is next. D is carrying three tickets and C none, so the
      // first sort key overrules the second. This is the case that distinguishes
      // this design from pure round-robin.
      await seedCursor(AGENT_C);
      await loadAgent(AGENT_D, 3);
      await loadAgent(AGENT_A, 2);
      await loadAgent(AGENT_B, 2);

      expect((await resolve()).userId).toBe(AGENT_C);
    });

    it('falls back to the ring only among agents that are equally loaded', async () => {
      // A and B both hold two; C and D both hold none. C and D are the tied
      // front group, and the cursor decides between those two — not between all
      // four.
      await seedCursor(AGENT_C);
      await loadAgent(AGENT_A, 2);
      await loadAgent(AGENT_B, 2);

      expect(await resolveTimes(2)).toEqual([AGENT_D, AGENT_C]);
    });

    it('counts only active tickets towards a load', async () => {
      // `resolved` and `closed` are finished work. Counting them would retire an
      // agent from the rotation permanently over the course of a week.
      await loadAgent(AGENT_A, 3);
      await systemPrisma.ticket.updateMany({
        where: { tenantId: TENANT, assignedUserId: AGENT_A },
        data: { status: 'closed' },
      });

      expect((await resolve()).userId).toBe(AGENT_A);
    });
  });

  describe('case 4 — deferral, and why', () => {
    it('reports `all_at_capacity` when everyone present is full', async () => {
      await systemPrisma.tenantSettings.create({
        data: { tenantId: TENANT, defaultMaxConcurrentTickets: 1 },
      });
      await Promise.all(AGENTS.map((agent) => loadAgent(agent, 1)));

      expect(await resolve()).toEqual({
        outcome: 'no_eligible_agent',
        userId: null,
        teamId: null,
        reason: 'all_at_capacity',
      });
    });

    it('reports `none_available` when everyone has set themselves away', async () => {
      await systemPrisma.user.updateMany({
        where: { tenantId: TENANT },
        data: { availability: 'away' },
      });

      expect((await resolve()).reason).toBe('none_available');
    });

    it('reports `none_available` when everyone has aged out of the presence window', async () => {
      // The predicate TAR-23's text does not name. An agent who set `available`
      // and shut the laptop stays `available` for ever, and without this
      // rotation feeds them a share of every ticket into a black hole — the
      // worse failure, because the tickets *look* assigned.
      await systemPrisma.user.updateMany({
        where: { tenantId: TENANT },
        data: { lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) },
      });

      expect((await resolve()).reason).toBe('none_available');
    });

    it('reports `none_available` for an agent who has never been seen at all', async () => {
      await systemPrisma.user.updateMany({
        where: { tenantId: TENANT },
        data: { lastSeenAt: null },
      });

      expect((await resolve()).reason).toBe('none_available');
    });

    it('reports `no_candidate_pool` for a team with no members', async () => {
      // A different person fixes this one: it is a configuration problem, not a
      // staffing one, and collapsing it into `none_available` would send a
      // supervisor hunting for absent colleagues who were never configured.
      expect(await resolve(EMPTY_TEAM)).toEqual({
        outcome: 'no_eligible_agent',
        userId: null,
        teamId: EMPTY_TEAM,
        reason: 'no_candidate_pool',
      });
    });

    it('writes no cursor when it defers', async () => {
      await systemPrisma.user.updateMany({
        where: { tenantId: TENANT },
        data: { availability: 'offline' },
      });

      await resolve();

      expect(await cursorFor(null)).toEqual([]);
    });

    it('excludes a suspended user from the pool entirely', async () => {
      await systemPrisma.user.updateMany({
        where: { tenantId: TENANT, role: 'agent' },
        data: { status: 'suspended' },
      });

      // Nobody could ever be a candidate here — a suspended account cannot log
      // in, so this is configuration rather than staffing.
      expect((await resolve()).reason).toBe('no_candidate_pool');

      await systemPrisma.user.updateMany({
        where: { tenantId: TENANT, role: 'agent' },
        data: { status: 'active' },
      });
    });
  });

  describe('the tenant pool excludes supervisors', () => {
    it('never routes to a supervisor who is not in a team', async () => {
      // A supervisor holds every agent permission, so without this every
      // tenant's supervisor is silently placed in the rotation and starts
      // receiving customer tickets between doing their own job.
      const picked = await resolveTimes(5);

      expect(picked).not.toContain(SUPERVISOR);
      expect(new Set(picked)).toEqual(new Set(AGENTS));
    });
  });

  describe('case 5 — tenant isolation', () => {
    it('cannot see another tenant’s agents, even when this tenant has none', async () => {
      // The other tenant holds exactly one active, available, idle agent. If the
      // candidate scan leaked across the boundary this would assign them.
      await systemPrisma.user.updateMany({
        where: { tenantId: TENANT },
        data: { availability: 'offline' },
      });
      await systemPrisma.user.updateMany({
        where: { tenantId: TENANT, role: 'agent' },
        data: { status: 'suspended' },
      });

      expect(await resolve(null, TENANT)).toMatchObject({
        outcome: 'no_eligible_agent',
        userId: null,
        reason: 'no_candidate_pool',
      });

      await systemPrisma.user.updateMany({
        where: { tenantId: TENANT, role: 'agent' },
        data: { status: 'active' },
      });
    });

    it('routes the other tenant to its own agent and to nobody else', async () => {
      expect(await resolve(null, OTHER_TENANT)).toMatchObject({
        outcome: 'assigned',
        userId: FOREIGN_AGENT,
      });
    });

    it('does not count another tenant’s tickets towards a load', async () => {
      // Load is the only number in this design read from a table the other
      // tenant also writes. `tenant_id` is on the predicate explicitly and RLS
      // filters it regardless; this asserts the pair actually holds.
      await loadAgent(AGENT_A, 3);

      const decision = await resolve(null, OTHER_TENANT);

      expect(decision.userId).toBe(FOREIGN_AGENT);
      expect(await cursorFor(null)).toEqual([]);
    });
  });
});

/** Loaded from the repository-root `.env` by `jest.int.setup.cjs`. */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(`${name} must be set to run the integration suite`);
  }

  return value;
}
