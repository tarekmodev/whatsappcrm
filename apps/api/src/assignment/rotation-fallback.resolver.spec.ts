import {
  ASSIGNMENT_POLICY,
  FallbackAssignmentDecisionSchema,
  FallbackAssignmentRequestSchema,
  TICKET_ACTIVE_STATUSES,
  type FallbackAssignmentDecision,
  type FallbackAssignmentRequest,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { FallbackAssignmentTenantMismatchError } from './assignment.errors';
import { RotationFallbackResolver } from './rotation-fallback.resolver';

/**
 * TAR-273 against the seam 0007 published, with no rule engine and no database.
 *
 * The request is a literal parsed through `FallbackAssignmentRequestSchema` and
 * every decision is parsed on the way back out through
 * `FallbackAssignmentDecisionSchema` — the point of 0007 fixing the shape before
 * either side existed. If a fixture stops matching the published schema these
 * tests stop compiling, and if TAR-288 sends something else its own tests fail
 * rather than this file silently passing.
 *
 * **What this file can prove:** which candidate is taken once the rows are back,
 * that an agent at their cap is skipped, which of the three reasons a failure
 * carries, that the cursor is read and advanced for the right scope, that a
 * request naming another tenant is refused, and that the statement it sends
 * carries the four eligibility predicates and the three sort keys.
 *
 * **What it cannot prove, and does not pretend to:** the ordering itself. The
 * least-loaded-then-rotation rule is one `ORDER BY` executed by PostgreSQL, and
 * a mocked client returning a hand-ordered array would only assert the array.
 * 0008's cases 1 and 3 — four equally-loaded agents taking turns, and a
 * less-loaded agent winning over one earlier in the ring — need a real database
 * and belong beside `src/prisma/ticket-active-uniqueness.int-spec.ts`, together
 * with the concurrency case. The structural assertions below are the honest
 * half: they prove the statement says what 0008 specified, not that PostgreSQL
 * sorts.
 */

const TENANT = '01923f4a-0000-7000-8000-0000000000c0';
/** A second tenant, only ever used as a value a payload might lie with. */
const OTHER_TENANT = '01923f4a-0000-7000-8000-0000000000d0';
const TICKET = '01923f4a-0000-7000-8000-0000000000c1';
const CONTACT = '01923f4a-0000-7000-8000-0000000000c2';
const TEAM = '01923f4a-0000-7000-8000-0000000000c3';

/** Ascending, because ascending `users.id` is the ring order. */
const AGENT_A = '01923f4a-0000-7000-8000-00000000000a';
const AGENT_B = '01923f4a-0000-7000-8000-00000000000b';

/** No rule matched, which is the only case TAR-24 uses today. */
const POOL_REQUEST: FallbackAssignmentRequest = FallbackAssignmentRequestSchema.parse({
  tenantId: TENANT,
  ticketId: TICKET,
  contactId: CONTACT,
  teamId: null,
});

const TEAM_REQUEST: FallbackAssignmentRequest = FallbackAssignmentRequestSchema.parse({
  ...POOL_REQUEST,
  teamId: TEAM,
});

interface CandidateRow {
  userId: string;
  cap: number;
  activeCount: number;
}

interface BuildOptions {
  /** In the order the database would return them. */
  readonly candidates?: readonly CandidateRow[];
  /** `assignment_state.last_assigned_user_id` for the scope, or null for a fresh ring. */
  readonly cursor?: string | null;
  /** Active users in the scope, ignoring availability and presence. */
  readonly usersInScope?: number;
}

/** One tagged-template call, split back into the statement and what was bound into it. */
interface RawCall {
  /** The literal chunks rejoined, with a `?` standing in for each bound value. */
  readonly sql: string;
  readonly params: readonly unknown[];
}

function firstRawCall(mock: jest.Mock): RawCall {
  const [strings, ...params] = mock.mock.calls[0] as [readonly string[], ...unknown[]];

  return { sql: strings.join(' ? '), params };
}

interface Harness {
  readonly findCursor: jest.Mock;
  readonly queryRaw: jest.Mock;
  readonly executeRaw: jest.Mock;
  readonly countUsers: jest.Mock;
  /** The candidate SELECT, for structural assertions. */
  candidate(): RawCall;
  /** Runs the resolver inside a tenant scope, the way the routing worker would. */
  resolve(
    request?: FallbackAssignmentRequest,
    scopedTenantId?: string,
  ): Promise<FallbackAssignmentDecision>;
}

function build({ candidates = [], cursor = null, usersInScope = 0 }: BuildOptions = {}): Harness {
  const findCursor = jest
    .fn()
    .mockResolvedValue(cursor === null ? null : { lastAssignedUserId: cursor });
  const queryRaw = jest.fn().mockResolvedValue(candidates);
  const executeRaw = jest.fn().mockResolvedValue(1);
  const countUsers = jest.fn().mockResolvedValue(usersInScope);

  const prisma = {
    assignmentState: { findFirst: findCursor },
    user: { count: countUsers },
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
  } as unknown as TenantPrisma;

  const tenantContext = new TenantContextService();
  const resolver = new RotationFallbackResolver(prisma, tenantContext);

  return {
    findCursor,
    queryRaw,
    executeRaw,
    countUsers,
    candidate: () => firstRawCall(queryRaw),
    resolve: (request = POOL_REQUEST, scopedTenantId = TENANT) =>
      tenantContext.run(
        { requestId: 'tar273-spec', tenantId: scopedTenantId, userId: null },
        async () =>
          // Parsed on the way out as well as on the way in: a decision that does
          // not satisfy the schema is a contract break, not a detail.
          FallbackAssignmentDecisionSchema.parse(await resolver.resolveFallbackAssignment(request)),
      ),
  };
}

describe('RotationFallbackResolver', () => {
  describe('choosing an agent', () => {
    it('takes the first candidate with room, and reports it as assigned', async () => {
      const harness = build({ candidates: [{ userId: AGENT_A, cap: 5, activeCount: 2 }] });

      await expect(harness.resolve()).resolves.toEqual({
        outcome: 'assigned',
        userId: AGENT_A,
        teamId: null,
        reason: null,
      });
    });

    it('skips an agent at their cap and takes the next in rotation', async () => {
      // The database put A first — fewer tickets, or earlier in the ring. A is
      // at their limit, so the ticket is B's. This is 0008's case 2, and the
      // half of it that lives in TypeScript rather than in the ORDER BY.
      const harness = build({
        candidates: [
          { userId: AGENT_A, cap: 2, activeCount: 2 },
          { userId: AGENT_B, cap: 5, activeCount: 4 },
        ],
      });

      const decision = await harness.resolve();

      expect(decision.userId).toBe(AGENT_B);
      expect(decision.outcome).toBe('assigned');
    });

    it('honours a per-agent cap that differs from the tenant default', async () => {
      // `cap` arrives already coalesced by the query, so an agent whose override
      // is lower than their current load is simply skipped — which is also what
      // happens to somebody whose cap was lowered below the work they hold. No
      // ticket is taken off them, which looks like a bug and is not.
      const harness = build({
        candidates: [
          { userId: AGENT_A, cap: 1, activeCount: 3 },
          { userId: AGENT_B, cap: 10, activeCount: 9 },
        ],
      });

      await expect(harness.resolve()).resolves.toMatchObject({ userId: AGENT_B });
    });

    it('carries the requested team back on the decision', async () => {
      const harness = build({ candidates: [{ userId: AGENT_A, cap: 5, activeCount: 0 }] });

      await expect(harness.resolve(TEAM_REQUEST)).resolves.toMatchObject({
        userId: AGENT_A,
        teamId: TEAM,
      });
    });
  });

  describe('when nobody can take it', () => {
    it('reports `all_at_capacity` when every candidate is at their limit', async () => {
      const harness = build({
        candidates: [
          { userId: AGENT_A, cap: 2, activeCount: 2 },
          { userId: AGENT_B, cap: 3, activeCount: 3 },
        ],
      });

      await expect(harness.resolve()).resolves.toEqual({
        outcome: 'no_eligible_agent',
        userId: null,
        teamId: null,
        reason: 'all_at_capacity',
      });
      // Candidates present answers the question on their own — the split query
      // is only paid for on the branch that needs it.
      expect(harness.countUsers).not.toHaveBeenCalled();
    });

    it('reports `none_available` when the scope has people but none is present', async () => {
      const harness = build({ candidates: [], usersInScope: 4 });

      await expect(harness.resolve()).resolves.toMatchObject({ reason: 'none_available' });
    });

    it('reports `no_candidate_pool` when the scope holds nobody at all', async () => {
      const harness = build({ candidates: [], usersInScope: 0 });

      await expect(harness.resolve()).resolves.toMatchObject({ reason: 'no_candidate_pool' });
    });

    it('asks about agents for the tenant pool, and about members for a team', async () => {
      const pool = build({ candidates: [], usersInScope: 0 });
      await pool.resolve();

      expect(pool.countUsers).toHaveBeenCalledWith({
        where: { tenantId: TENANT, status: 'active', role: 'agent' },
      });

      const team = build({ candidates: [], usersInScope: 0 });
      await team.resolve(TEAM_REQUEST);

      expect(team.countUsers).toHaveBeenCalledWith({
        where: {
          tenantId: TENANT,
          status: 'active',
          teamMemberships: { some: { tenantId: TENANT, teamId: TEAM } },
        },
      });
    });

    it('leaves the cursor where it was', async () => {
      // Nobody took a turn, so nobody's turn is over. Advancing here would skip
      // a live agent the next time capacity frees.
      const harness = build({ candidates: [], usersInScope: 2 });

      await harness.resolve();

      expect(harness.executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('the rotation cursor', () => {
    it('reads the scope with a filter, so the tenant pool is `team_id IS NULL`', async () => {
      // `findFirst` and not `findUnique`: Prisma's compound unique input compiles
      // a null to `team_id = NULL`, which matches nothing, and the pool cursor
      // would be re-inserted on every ticket.
      const harness = build({ candidates: [{ userId: AGENT_A, cap: 5, activeCount: 0 }] });

      await harness.resolve();

      expect(harness.findCursor).toHaveBeenCalledWith({
        where: { tenantId: TENANT, teamId: null },
        select: { lastAssignedUserId: true },
      });
    });

    it('passes the cursor into the query as the rotation key', async () => {
      const harness = build({
        cursor: AGENT_A,
        candidates: [{ userId: AGENT_B, cap: 5, activeCount: 0 }],
      });

      await harness.resolve();

      expect(harness.candidate().params).toContain(AGENT_A);
    });

    it('starts the ring at the lowest id when the scope has never assigned', async () => {
      // A null cursor makes the `>` comparison NULL, the coalesce makes it false
      // for every row, and the third sort key applies. No special case here, and
      // none for QA to miss.
      const harness = build({ candidates: [{ userId: AGENT_A, cap: 5, activeCount: 0 }] });

      await harness.resolve();

      expect(harness.candidate().params).toContain(null);
      expect(harness.candidate().sql).toContain('coalesce(c.id >');
    });

    it('advances to the chosen agent for the scope that was routed', async () => {
      const harness = build({ candidates: [{ userId: AGENT_B, cap: 5, activeCount: 1 }] });

      await harness.resolve(TEAM_REQUEST);

      expect(harness.executeRaw).toHaveBeenCalledTimes(1);
      const advance = firstRawCall(harness.executeRaw);
      expect(advance.sql).toContain('ON CONFLICT (tenant_id, team_id) DO UPDATE');
      // A generated uuid v7, the tenant in scope, the scope, and who was picked.
      expect(advance.params).toEqual([expect.any(String), TENANT, TEAM, AGENT_B]);
    });
  });

  describe('tenant scope', () => {
    it('refuses a request naming a tenant other than the one in scope', async () => {
      const harness = build({ candidates: [{ userId: AGENT_A, cap: 5, activeCount: 0 }] });
      const forged = FallbackAssignmentRequestSchema.parse({
        ...POOL_REQUEST,
        tenantId: OTHER_TENANT,
      });

      await expect(harness.resolve(forged)).rejects.toBeInstanceOf(
        FallbackAssignmentTenantMismatchError,
      );
      expect(harness.queryRaw).not.toHaveBeenCalled();
      expect(harness.executeRaw).not.toHaveBeenCalled();
    });

    it('throws rather than deciding when there is no tenant in scope', async () => {
      const prisma = {} as unknown as TenantPrisma;
      const resolver = new RotationFallbackResolver(prisma, new TenantContextService());

      await expect(resolver.resolveFallbackAssignment(POOL_REQUEST)).rejects.toThrow(
        /No tenant in scope/,
      );
    });

    it('binds the tenant in scope into every predicate of the candidate query', async () => {
      // Not the one the payload claims. RLS filters regardless; this is what
      // makes the planner use the `(tenant_id, ...)` composite indexes, and what
      // stops a forged payload influencing a row even if the guard above were
      // removed.
      const harness = build({ candidates: [{ userId: AGENT_A, cap: 5, activeCount: 0 }] });

      await harness.resolve();

      const params = harness.candidate().params;
      expect(params.filter((value) => value === TENANT)).toHaveLength(3);
      expect(params).not.toContain(OTHER_TENANT);
    });
  });

  describe('the candidate statement', () => {
    it('carries all four eligibility predicates', async () => {
      const harness = build({ candidates: [] });

      await harness.resolve();
      const sql = harness.candidate().sql;

      expect(sql).toContain("u.status = 'active'");
      expect(sql).toContain("u.availability = 'available'");
      expect(sql).toContain('u.last_seen_at > now() -');
      expect(sql).toContain('coalesce(u.max_concurrent_tickets, d.value) AS cap');
    });

    it('sorts by load first, then rotation, then a total order', async () => {
      const harness = build({ candidates: [] });

      await harness.resolve();
      const sql = harness.candidate().sql;

      const load = sql.indexOf('"activeCount" ASC');
      const rotation = sql.indexOf('coalesce(c.id >');
      const total = sql.indexOf('c.id ASC');

      expect(load).toBeGreaterThan(-1);
      expect(load).toBeLessThan(rotation);
      expect(rotation).toBeLessThan(total);
    });

    it('scopes the pool to agents and a team to its members', async () => {
      const harness = build({ candidates: [] });

      await harness.resolve();

      expect(harness.candidate().sql).toContain("THEN u.role = 'agent' ELSE tm.id IS NOT NULL END");
    });

    it('falls back to the policy default when the tenant has no settings row', async () => {
      const harness = build({ candidates: [] });

      await harness.resolve();

      expect(harness.candidate().sql).toContain('SELECT coalesce(');
      expect(harness.candidate().params).toContain(ASSIGNMENT_POLICY.defaultMaxConcurrentTickets);
    });

    it('bounds presence by the policy window rather than a literal', async () => {
      const harness = build({ candidates: [] });

      await harness.resolve();

      expect(harness.candidate().params).toContain(ASSIGNMENT_POLICY.presenceWindowMs);
    });

    it('counts load over exactly the statuses the contract calls active', async () => {
      // The statuses are a literal in the SQL — the same choice
      // `TicketLinkerService.create` makes for `ON CONFLICT ... WHERE`. This is
      // the drift guard: widening `TICKET_ACTIVE_STATUSES` without widening the
      // statement would silently under-count every agent's load and let the cap
      // be exceeded.
      expect([...TICKET_ACTIVE_STATUSES]).toEqual(['open', 'pending']);

      const harness = build({ candidates: [] });
      await harness.resolve();

      expect(harness.candidate().sql).toContain("t.status IN ('open', 'pending')");
    });
  });

  describe('the presence window', () => {
    it('is longer than the session touch throttle it has to outlive', async () => {
      // 0008 decision 1: shorter than `AUTH_POLICY.sessionSlideThrottleMs` and a
      // working agent could age out between two writes of their own session,
      // which would defer tickets for people sitting at their desks.
      const { AUTH_POLICY } = await import('@whatsappcrm/contracts');

      expect(ASSIGNMENT_POLICY.presenceWindowMs).toBeGreaterThan(
        AUTH_POLICY.sessionSlideThrottleMs,
      );
    });
  });
});
