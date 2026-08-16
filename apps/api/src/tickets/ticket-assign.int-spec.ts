import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  permissionsForRole,
  type SessionPrincipal,
  type TenantRole,
  type TicketResponse,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import type { QueueService } from '../queue/queue.service';
import { EscalationAlertService } from './escalation-alert.service';
import { TicketCommandService } from './ticket-command.service';
import { TicketQueryService } from './ticket-query.service';
import { TicketNotFoundError, UnknownTicketAssigneeError } from './tickets.errors';

/**
 * `POST /api/v1/tickets/{id}/assign` against a real PostgreSQL with TAR-48's
 * policies applied, running as `whatsappcrm_app` — the role holding no
 * `BYPASSRLS` (TAR-374, 0008 decision 3 and amendment 2).
 *
 * The unit spec proves the rules. Only this can prove the three claims that live
 * in the database rather than in TypeScript:
 *
 *   * **`tickets_routing_deferred_consistent` accepts the write.** The CHECK
 *     makes `routing_state = 'deferred'` equivalent to both deferred columns
 *     being non-null, so a version of this endpoint that moved the state without
 *     nulling them would pass every mocked test and fail on the one row the
 *     feature exists for. Both directions out of `deferred` are exercised — to
 *     `manual` and, per amendment 2, to `pending`;
 *   * **`pending` is legal after the insert.** It is not an insert-only value,
 *     whatever the column default suggests;
 *   * **an assignee from another tenant does not exist here.** The lookup is
 *     tenant-scoped, so RLS is what refuses it — not a filter somebody
 *     remembered to write — and a supervisor cannot reach a neighbour's ticket
 *     at all.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Two fixture
 * tenants with fixed ids and a `tar374-fixture` slug, deleted before the run as
 * well as after it, so an interrupted run cleans up on the next one. Point
 * `pnpm test:db` at a local or disposable database.
 *
 * Prerequisites — the four commands in the README:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '25374444-4444-7444-8444-444444444401';
const TENANT_B = '25374444-4444-7444-8444-444444444402';

const SUPERVISOR_A = '25374444-4444-7444-8444-4444444444d0';
const AGENT_A = '25374444-4444-7444-8444-4444444444d1';
/** Same tenant, cannot take work: a removed contractor whose account is cut. */
const SUSPENDED_A = '25374444-4444-7444-8444-4444444444d2';
const SUPERVISOR_B = '25374444-4444-7444-8444-4444444444d8';
const AGENT_B = '25374444-4444-7444-8444-4444444444d9';

const TEAM_A = '25374444-4444-7444-8444-4444444444b1';
const TEAM_B = '25374444-4444-7444-8444-4444444444b9';

/** Unassigned, `deferred`, and the row TAR-274's flagged queue is built from. */
const DEFERRED = '25374444-4444-7444-8444-4444444444f1';
/** Already an agent's, so the reassignment case has somebody to take it from. */
const HELD = '25374444-4444-7444-8444-4444444444f2';
const TENANT_B_TICKET = '25374444-4444-7444-8444-4444444444f9';

const REQUEST_ID = 'tar374-int-spec';
const FIXTURE_PREFIX = 'tar374-fixture';

const DEFERRED_SINCE = new Date('2026-08-14T08:00:00.000Z');

function principalFor(tenantId: string, userId: string, role: TenantRole): SessionPrincipal {
  return {
    userId,
    tenantId,
    email: `${userId}@example.invalid`,
    displayName: 'Fixture user',
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [],
    sessionId: userId,
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

describe('assigning a ticket by hand, end to end', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let tickets: TicketQueryService;
  let commands: TicketCommandService;

  function as<T>(principal: SessionPrincipal, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      {
        requestId: REQUEST_ID,
        tenantId: principal.tenantId,
        userId: principal.userId,
        principal,
      },
      async () => await work(),
    );
  }

  /** The supervisor of tenant A, who is the only caller `ticket:assign` admits. */
  function supervisorA(): SessionPrincipal {
    return principalFor(TENANT_A, SUPERVISOR_A, 'supervisor');
  }

  function assign(
    ticketId: string,
    input: Parameters<TicketCommandService['assign']>[1],
    principal: SessionPrincipal = supervisorA(),
  ): Promise<TicketResponse> {
    return as(principal, async () => commands.assign(ticketId, input));
  }

  /** The flagged queue exactly as TAR-274 asks for it (0008 decision 3). */
  function flaggedQueue(): Promise<string[]> {
    return as(supervisorA(), async () => {
      const page = await tickets.list({
        limit: 25,
        scope: 'all',
        routingState: 'deferred',
        breachedOnly: false,
      });

      return page.items.map((ticket) => ticket.id);
    });
  }

  function eventsOn(
    ticketId: string,
  ): Promise<{ type: string; actorUserId: string | null; data: unknown }[]> {
    return as(supervisorA(), async () =>
      tenantPrisma.ticketEvent.findMany({
        where: { ticketId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { type: true, actorUserId: true, data: true },
      }),
    );
  }

  async function removeFixture(): Promise<void> {
    // Everything below cascades from `tenants`.
    await systemPrisma.tenant.deleteMany({ where: { slug: { startsWith: FIXTURE_PREFIX } } });
  }

  /**
   * The three tickets, re-seeded before every case so none of them depends on
   * another having run — and so the `deferred` row is genuinely deferred each
   * time rather than whatever the previous case left.
   */
  async function seedTickets(): Promise<void> {
    await systemPrisma.ticketEvent.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.ticket.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });

    await systemPrisma.ticket.createMany({
      data: [
        {
          id: DEFERRED,
          tenantId: TENANT_A,
          number: 1,
          status: 'open',
          priority: 'urgent',
          routingState: 'deferred',
          routingDeferredReason: 'all_at_capacity',
          routingDeferredSince: DEFERRED_SINCE,
        },
        {
          id: HELD,
          tenantId: TENANT_A,
          number: 2,
          status: 'open',
          assignedUserId: AGENT_A,
        },
        {
          id: TENANT_B_TICKET,
          tenantId: TENANT_B,
          number: 1,
          status: 'open',
          routingState: 'deferred',
          routingDeferredReason: 'none_available',
          routingDeferredSince: DEFERRED_SINCE,
        },
      ],
    });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    tickets = new TicketQueryService(tenantPrisma, tenantContext);
    commands = new TicketCommandService(
      tenantPrisma,
      tickets,
      tenantContext,
      new EventEmitter2(),
      // No Redis in this suite, and none needed: an assignment enqueues nothing
      // in any case — 0006's fourth SLA trigger is a *status* change.
      stubQueue(),
      // Real, and against the same scoped client: nothing here escalates, but a
      // stub would make the wiring untested in the one suite that has a database.
      new EscalationAlertService(tenantPrisma, tenantContext),
    );

    await removeFixture();
    await seedFixture(systemPrisma);
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(seedTickets);

  describe('a flagged ticket the supervisor places', () => {
    it('comes back manual with both deferred columns cleared', async () => {
      // The write the CHECK constraint would refuse if the four columns were not
      // moved in one statement.
      const assigned = await assign(DEFERRED, { userId: AGENT_A, reason: 'Nobody else free' });

      expect(assigned).toMatchObject({ id: DEFERRED, assignedUserId: AGENT_A });
      expect(assigned.routing).toEqual({
        state: 'manual',
        deferredReason: null,
        deferredSince: null,
      });
    });

    it('leaves the flagged queue, which is what that view is claiming', async () => {
      expect(await flaggedQueue()).toEqual([DEFERRED]);

      await assign(DEFERRED, { userId: AGENT_A });

      expect(await flaggedQueue()).toEqual([]);
    });

    it('appends one assigned event naming the supervisor and their reason', async () => {
      await assign(DEFERRED, { userId: AGENT_A, reason: 'Nobody else free' });

      expect(await eventsOn(DEFERRED)).toEqual([
        {
          type: 'assigned',
          // A person, unlike the router's system-null actor.
          actorUserId: SUPERVISOR_A,
          data: {
            assignedUserId: AGENT_A,
            assignedTeamId: null,
            previousAssignedUserId: null,
            previousAssignedTeamId: null,
            cause: 'agent',
            reason: 'Nobody else free',
          },
        },
      ]);
    });

    it('routes to a team the same way', async () => {
      const assigned = await assign(DEFERRED, { teamId: TEAM_A });

      expect(assigned.assignedTeamId).toBe(TEAM_A);
      expect(assigned.routing.state).toBe('manual');
    });
  });

  /**
   * `HELD` is held by an agent, so every release below is a *reassignment* and
   * carries a reason — TAR-32's rule, published as `ticketAssignRequiresReason`
   * and enforced in `TicketCommandService.assign`. The reasonless case is the
   * placement of `DEFERRED` above, which is the asymmetry ADR 0011 decision 1
   * designs.
   */
  describe('an explicit release', () => {
    it('returns the ticket to pending, which the CHECK accepts after the insert', async () => {
      // 0008 amendment 2, and the assertion that `pending` is not an insert-only
      // value: nobody holds it, and no supervisor has judged it stuck.
      const released = await assign(HELD, {
        userId: null,
        teamId: null,
        reason: 'Ada has left the team',
      });

      expect(released.assignedUserId).toBeNull();
      expect(released.routing).toEqual({
        state: 'pending',
        deferredReason: null,
        deferredSince: null,
      });
    });

    it('does not put the ticket back in the flagged queue', async () => {
      // A supervisor releasing a ticket deliberately is not rotation failing to
      // place one, and the two must not read the same.
      await assign(HELD, { userId: null, teamId: null, reason: 'Ada has left the team' });

      expect(await flaggedQueue()).toEqual([DEFERRED]);
    });

    it('records it as unassigned, carrying who had it and why', async () => {
      await assign(HELD, { userId: null, reason: 'Ada has left the team' });

      expect(await eventsOn(HELD)).toEqual([
        {
          type: 'unassigned',
          actorUserId: SUPERVISOR_A,
          data: {
            assignedUserId: null,
            assignedTeamId: null,
            previousAssignedUserId: AGENT_A,
            previousAssignedTeamId: null,
            cause: 'agent',
            reason: 'Ada has left the team',
          },
        },
      ]);
    });
  });

  describe('the tenant boundary', () => {
    it('refuses a userId belonging to the neighbouring tenant, and writes nothing', async () => {
      await expect(assign(DEFERRED, { userId: AGENT_B })).rejects.toBeInstanceOf(
        UnknownTicketAssigneeError,
      );

      const untouched = await as(supervisorA(), async () => tickets.get(DEFERRED));

      expect(untouched.routing.state).toBe('deferred');
      expect(await eventsOn(DEFERRED)).toEqual([]);
    });

    it('refuses a teamId belonging to the neighbouring tenant', async () => {
      await expect(assign(DEFERRED, { teamId: TEAM_B })).rejects.toBeInstanceOf(
        UnknownTicketAssigneeError,
      );
    });

    it('refuses a user who is not active', async () => {
      // Same tenant and perfectly visible; what refuses it is `status = active`.
      await expect(assign(DEFERRED, { userId: SUSPENDED_A })).rejects.toBeInstanceOf(
        UnknownTicketAssigneeError,
      );
    });

    it('does not let a neighbour’s supervisor reach the ticket at all', async () => {
      // `not_found` rather than `forbidden`, and it never gets as far as the
      // assignee lookup: RLS makes tenant A's row invisible to tenant B.
      await expect(
        assign(DEFERRED, { userId: AGENT_B }, principalFor(TENANT_B, SUPERVISOR_B, 'supervisor')),
      ).rejects.toBeInstanceOf(TicketNotFoundError);

      const untouched = await as(supervisorA(), async () => tickets.get(DEFERRED));

      expect(untouched.routing.state).toBe('deferred');
    });
  });

  describe('a repeated submit', () => {
    it('answers with the ticket and appends no second event', async () => {
      // A double-clicked Assign button, and a retry after a dropped response.
      // The second submit carries a reason because the first one gave the ticket
      // a holder — the rule is about the row, not about the request.
      await assign(DEFERRED, { userId: AGENT_A });
      const again = await assign(DEFERRED, { userId: AGENT_A, reason: 'Retrying the placement' });

      expect(again.assignedUserId).toBe(AGENT_A);
      expect(await eventsOn(DEFERRED)).toHaveLength(1);
    });
  });
});

async function seedFixture(systemPrisma: PrismaClient): Promise<void> {
  await systemPrisma.tenant.createMany({
    data: [
      { id: TENANT_A, slug: `${FIXTURE_PREFIX}-a`, name: 'TAR-374 fixture A', status: 'active' },
      { id: TENANT_B, slug: `${FIXTURE_PREFIX}-b`, name: 'TAR-374 fixture B', status: 'active' },
    ],
  });

  await systemPrisma.team.createMany({
    data: [
      { id: TEAM_A, tenantId: TENANT_A, name: 'TAR-374 support' },
      { id: TEAM_B, tenantId: TENANT_B, name: 'TAR-374 neighbours' },
    ],
  });

  await systemPrisma.user.createMany({
    data: [
      {
        id: SUPERVISOR_A,
        tenantId: TENANT_A,
        email: 'tar374-supervisor-a@fixture.test',
        name: 'Supervisor A',
        role: 'supervisor',
        status: 'active',
      },
      {
        id: AGENT_A,
        tenantId: TENANT_A,
        email: 'tar374-agent-a@fixture.test',
        name: 'Agent A',
        role: 'agent',
        status: 'active',
      },
      {
        id: SUSPENDED_A,
        tenantId: TENANT_A,
        email: 'tar374-suspended-a@fixture.test',
        name: 'Suspended A',
        role: 'agent',
        status: 'suspended',
      },
      {
        id: SUPERVISOR_B,
        tenantId: TENANT_B,
        email: 'tar374-supervisor-b@fixture.test',
        name: 'Supervisor B',
        role: 'supervisor',
        status: 'active',
      },
      {
        id: AGENT_B,
        tenantId: TENANT_B,
        email: 'tar374-agent-b@fixture.test',
        name: 'Agent B',
        role: 'agent',
        status: 'active',
      },
    ],
  });

  // Past every seeded `number`, so nothing that allocates one can collide with
  // the fixture on `UNIQUE (tenant_id, number)`.
  await systemPrisma.ticketCounter.createMany({
    data: [
      { tenantId: TENANT_A, nextNumber: 100 },
      { tenantId: TENANT_B, nextNumber: 100 },
    ],
  });
}

/**
 * A `QueueService` with no Redis behind it, which is the state a bare clone runs
 * in. Nothing here should reach it: an assignment moves no SLA timer.
 */
function stubQueue(): QueueService {
  return { enqueue: () => Promise.resolve('unavailable' as const) } as unknown as QueueService;
}

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
