import {
  permissionsForRole,
  type FallbackAssignmentReason,
  type Permission,
  type SessionPrincipal,
  type TicketResponse,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { TicketQueryService } from './ticket-query.service';
import { InvalidTicketCursorError } from './tickets.errors';

/**
 * The supervisor's flagged queue — `?routingState=deferred`, optionally narrowed
 * to one `deferredReason` — against a real PostgreSQL under TAR-48's policies,
 * as `whatsappcrm_app`.
 *
 * Its own file rather than a block in `ticket-queue.int-spec.ts`: that fixture
 * asserts the active queue's whole page by exact equality, so adding a ticket to
 * its tenant would rewrite an unrelated expectation, and its blocks deliberately
 * mutate rows in declaration order. This one seeds a set nothing else touches.
 *
 * What only a database can show, and what this asserts:
 *
 *   * the flagged page is ordered **oldest stuck first** —
 *     `routing_deferred_since ASC, id ASC` — which is ADR 0008 decision 3's
 *     ordering and *not* the queue's `(priority, created_at, id)`. The fixture
 *     inverts priority against deferral age on purpose, so a page that came back
 *     in the queue's order fails rather than looking plausible;
 *   * it pages. A queue longer than one page hands back a real cursor and the
 *     walk loses nothing — including across two tickets deferred in the same
 *     millisecond, which is the tie group a single-column keyset drops silently;
 *   * `deferredReason` narrows the **query**, so its second page exists too;
 *   * the two shapes' cursors cannot cross: a queue cursor carries two sort
 *     values and a flagged cursor carries one, and each shape refuses the
 *     other's rather than paging from the wrong place;
 *   * a resolved ticket that is still flagged is out of the queue, and a
 *     `pending`/`assigned`/`manual` ticket was never in it;
 *   * tenant A's supervisor cannot see tenant B's stuck ticket, and an agent
 *     without `ticket:read_all` cannot use this filter to browse the tenant's
 *     untriaged backlog at all.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Two fixture
 * tenants with fixed ids and a `tar365-fixture` marker, deleted before the run
 * as well as after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '25366666-6666-7666-8666-666666666601';
const TENANT_B = '25366666-6666-7666-8666-666666666602';

const SUPERVISOR_A = '25366666-6666-7666-8666-6666666666d0';
const AGENT_A = '25366666-6666-7666-8666-6666666666d1';
const SUPERVISOR_B = '25366666-6666-7666-8666-6666666666d9';

const TEAM_A = '25366666-6666-7666-8666-6666666666e0';

/**
 * The flagged set, named by how long it has been stuck rather than by reason, so
 * the expectations below read as the order they assert.
 *
 * `TIED_EARLY` and `TIED_LATE` share a `routing_deferred_since` to the
 * millisecond and are separated only by their ids — the tie group the id
 * tie-breaker exists for.
 */
const STUCK_9H = '25366666-6666-7666-8666-666666666f01';
const STUCK_7H = '25366666-6666-7666-8666-666666666f02';
const TIED_EARLY = '25366666-6666-7666-8666-666666666f03';
const TIED_LATE = '25366666-6666-7666-8666-666666666f04';
const STUCK_2H = '25366666-6666-7666-8666-666666666f05';
const STUCK_TEAM = '25366666-6666-7666-8666-666666666f06';

/** Flagged, and then resolved — out of the queue by the active-status default. */
const STUCK_BUT_RESOLVED = '25366666-6666-7666-8666-666666666f07';
/** Never deferred: the three routing states the flagged filter must exclude. */
const ROUTING_PENDING = '25366666-6666-7666-8666-666666666f08';
const ROUTING_ASSIGNED = '25366666-6666-7666-8666-666666666f09';
const ROUTING_MANUAL = '25366666-6666-7666-8666-666666666f0a';

const TENANT_B_STUCK = '25366666-6666-7666-8666-666666666f0b';

/**
 * The flagged queue as the fixture defines it: `routing_deferred_since ASC,
 * id ASC` over tenant A's six active deferred tickets.
 *
 * Written out rather than derived, so a change to the order has to be a change to
 * this list — a computed expectation would re-derive the bug. Under the *queue's*
 * order this list would be `STUCK_2H, TIED_EARLY, STUCK_TEAM, …`, because the
 * fixture gives the newest flag the highest priority.
 */
const FLAGGED_IN_ORDER = [STUCK_9H, STUCK_7H, TIED_EARLY, TIED_LATE, STUCK_TEAM, STUCK_2H] as const;

const REQUEST_ID = 'tar365-int-spec';
const FIXTURE_PREFIX = 'tar365-fixture';

const HOUR_MS = 60 * 60 * 1_000;
const NEXT_TICKET_NUMBER = 50;

interface SeededTicket {
  readonly id: string;
  readonly priority: 'low' | 'normal' | 'high' | 'urgent';
  readonly status: 'open' | 'pending' | 'resolved';
  /** How long ago routing gave up on it, in hours. `null` for a ticket it did not. */
  readonly deferredHoursAgo: number | null;
  readonly reason: FallbackAssignmentReason | null;
  readonly routingState: 'pending' | 'assigned' | 'deferred' | 'manual';
  readonly assignedUserId?: string;
  readonly assignedTeamId?: string;
}

function principalFor(
  tenantId: string,
  userId: string,
  role: 'agent' | 'supervisor',
  permissions: readonly Permission[] = permissionsForRole(role),
): SessionPrincipal {
  return {
    userId,
    tenantId,
    email: `${userId}@example.invalid`,
    displayName: 'Fixture user',
    role,
    permissions: [...permissions],
    teamIds: [],
    sessionId: userId,
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

/** A cursor of the given arity, minted by hand — what a foreign shape sends. */
function cursorWith(sortValues: string[], id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, k: sortValues, id }), 'utf8').toString('base64url');
}

describe('the supervisor’s flagged queue, end to end', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let tickets: TicketQueryService;

  function as<T>(principal: SessionPrincipal, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId: principal.tenantId, userId: principal.userId, principal },
      async () => await work(),
    );
  }

  function list(
    principal: SessionPrincipal,
    query: Partial<Parameters<TicketQueryService['list']>[0]> = {},
  ): Promise<{ items: TicketResponse[]; nextCursor: string | null }> {
    return as(principal, async () =>
      tickets.list({ limit: 25, scope: 'all', breachedOnly: false, ...query }),
    );
  }

  /** The landing query TAR-274 sends: every stuck ticket, whoever it was routed to. */
  function flagged(
    principal: SessionPrincipal,
    query: Partial<Parameters<TicketQueryService['list']>[0]> = {},
  ): Promise<{ items: TicketResponse[]; nextCursor: string | null }> {
    return list(principal, { routingState: 'deferred', ...query });
  }

  /** Walks every page of a query, following its own cursors. */
  async function walk(
    principal: SessionPrincipal,
    query: Partial<Parameters<TicketQueryService['list']>[0]>,
  ): Promise<string[]> {
    const walked: string[] = [];
    let cursor: string | undefined;

    do {
      const page = await flagged(principal, { ...query, cursor });

      walked.push(...page.items.map((ticket) => ticket.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    return walked;
  }

  async function removeFixture(): Promise<void> {
    // Everything below cascades from `tenants`.
    await systemPrisma.tenant.deleteMany({ where: { slug: { startsWith: FIXTURE_PREFIX } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    tickets = new TicketQueryService(tenantPrisma, tenantContext);

    await removeFixture();
    await seedFixture(systemPrisma);
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  describe('the order', () => {
    it('returns the stuck tickets oldest-flagged first, not in the queue’s order', async () => {
      const page = await flagged(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'));

      expect(page.items.map((ticket) => ticket.id)).toEqual([...FLAGGED_IN_ORDER]);
      expect(page.nextCursor).toBeNull();
    });

    it('is the ordering ADR 0008 decision 3 gives routing_deferred_since for', async () => {
      // The claim the console's "showing the N longest-waiting" line makes. Read
      // off the published field rather than the fixture, so a mapper that dropped
      // the column fails here too.
      const page = await flagged(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'));
      const flags = page.items.map((ticket) => ticket.routing.deferredSince ?? '');

      expect([...flags].sort()).toEqual(flags);
    });

    it('does not fall back to the queue’s priority order', async () => {
      // The fixture gives the newest flag the highest priority, so the two orders
      // disagree on the first row. Without this a page ordered by priority would
      // still look like a reasonable answer.
      const page = await flagged(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'));

      expect(page.items[0]?.priority).not.toBe('urgent');
      expect(page.items.at(-1)?.id).toBe(STUCK_2H);
    });
  });

  describe('paging', () => {
    it('hands back a real cursor and walks the whole queue without skipping a row', async () => {
      // The regression this exists for: answering `nextCursor: null` on this
      // shape would report the first page as the whole queue, and a supervisor
      // has no way to tell. Three pages of two, including the tie group.
      const walked = await walk(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), { limit: 2 });

      expect(walked).toEqual([...FLAGGED_IN_ORDER]);
    });

    it('does not lose a row to a page boundary inside one millisecond', async () => {
      // `TIED_EARLY` and `TIED_LATE` share `routing_deferred_since` exactly, and
      // the boundary is drawn between them. A keyset on the timestamp alone
      // returns one of the two and drops the other, with no error anywhere.
      const supervisor = principalFor(TENANT_A, SUPERVISOR_A, 'supervisor');
      const first = await flagged(supervisor, { limit: 3 });

      expect(first.items.map((ticket) => ticket.id)).toEqual([STUCK_9H, STUCK_7H, TIED_EARLY]);
      expect(first.nextCursor).not.toBeNull();

      const second = await flagged(supervisor, { limit: 3, cursor: first.nextCursor ?? undefined });

      expect(second.items.map((ticket) => ticket.id)).toEqual([TIED_LATE, STUCK_TEAM, STUCK_2H]);
    });

    it('pages a reason-narrowed queue too', async () => {
      // `deferredReason` narrows the query, so its own second page has to exist.
      // Filtering a fetched page instead would report "no tickets for that
      // reason" for every match that sorted past the first page.
      const walked = await walk(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), {
        limit: 1,
        deferredReason: 'all_at_capacity',
      });

      expect(walked).toEqual([STUCK_9H, TIED_EARLY, TIED_LATE]);
    });
  });

  describe('the reason filter', () => {
    it('returns only the tickets flagged for that reason', async () => {
      const page = await flagged(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), {
        deferredReason: 'none_available',
      });

      expect(page.items.map((ticket) => ticket.id)).toEqual([STUCK_7H, STUCK_2H]);
      expect(page.items.every((ticket) => ticket.routing.deferredReason === 'none_available')).toBe(
        true,
      );
    });

    it('pins the deferred set on its own, without routingState', async () => {
      // The CHECK makes a non-null reason equivalent to `routing_state =
      // 'deferred'`, so the reason alone identifies the flagged set — and it has
      // to page in the flagged order, or a cursor minted here would be replayed
      // against the other shape.
      const page = await list(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), {
        deferredReason: 'no_candidate_pool',
      });

      expect(page.items.map((ticket) => ticket.id)).toEqual([STUCK_TEAM]);
    });

    it('answers an empty page when nothing matches, rather than an unfiltered one', async () => {
      // The failure the console's `assertRoutingFilterHonoured` was written
      // against: an ignored filter answers with a *valid* page of the wrong set,
      // and "Showing 0" above a full table is how a supervisor finds out.
      const page = await flagged(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), {
        deferredReason: 'none_available',
        priority: 'low',
      });

      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });

    it('satisfies the console’s own guard on every reason pill', async () => {
      // `assertRoutingFilterHonoured` (`apps/web/features/assignment/
      // flagged-tickets.data.ts`) fails the section closed when a row disagrees
      // with the filter it asked for, so every reason pill threw into
      // `SectionErrorBoundary` while this predicate was unimplemented. Its exact
      // condition, applied to real responses, is the API half of "the pills work
      // again" — the console's half is its own suite, against a mocked transport.
      const supervisor = principalFor(TENANT_A, SUPERVISOR_A, 'supervisor');
      const reasons: FallbackAssignmentReason[] = [
        'all_at_capacity',
        'none_available',
        'no_candidate_pool',
      ];

      for (const reason of reasons) {
        const page = await flagged(supervisor, { deferredReason: reason });

        expect(page.items.length).toBeGreaterThan(0);
        expect(
          page.items.find(
            (ticket) =>
              ticket.routing.state !== 'deferred' || ticket.routing.deferredReason !== reason,
          ),
        ).toBeUndefined();
      }
    });
  });

  describe('what is not in it', () => {
    it('excludes a flagged ticket that has since been resolved', async () => {
      const page = await flagged(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'));

      expect(page.items.map((ticket) => ticket.id)).not.toContain(STUCK_BUT_RESOLVED);
    });

    it('is still reachable by asking for that status explicitly', async () => {
      const page = await flagged(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), {
        status: 'resolved',
      });

      expect(page.items.map((ticket) => ticket.id)).toEqual([STUCK_BUT_RESOLVED]);
    });

    it('excludes every routing state that is not deferred', async () => {
      const page = await flagged(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'));
      const returned = page.items.map((ticket) => ticket.id);

      expect(returned).not.toContain(ROUTING_PENDING);
      expect(returned).not.toContain(ROUTING_ASSIGNED);
      expect(returned).not.toContain(ROUTING_MANUAL);
      expect(page.items.every((ticket) => ticket.routing.state === 'deferred')).toBe(true);
    });

    it('drops a team-routed stuck ticket under scope=unassigned', async () => {
      // Why the console sends `scope=all`: TAR-286 fixed `unassigned` as "no user
      // **and** no team", and a ticket a rule routed to a team and rotation then
      // deferred still carries `assignedTeamId`.
      const page = await flagged(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), {
        scope: 'unassigned',
      });

      expect(page.items.map((ticket) => ticket.id)).not.toContain(STUCK_TEAM);
      expect(page.items.map((ticket) => ticket.id)).toContain(STUCK_9H);
    });
  });

  describe('cursors cannot cross between the two shapes', () => {
    it('refuses a queue cursor on the flagged queue', async () => {
      // Two sort values where this shape reads one. Paging from it would compare
      // an enum label against a timestamp column.
      const queueCursor = cursorWith(['urgent', '2026-08-11T09:00:00.000Z'], STUCK_9H);

      await expect(
        flagged(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), { cursor: queueCursor }),
      ).rejects.toBeInstanceOf(InvalidTicketCursorError);
    });

    it('refuses a flagged cursor on the queue', async () => {
      const flaggedCursor = cursorWith(['2026-08-11T09:00:00.000Z'], STUCK_9H);

      await expect(
        list(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), { cursor: flaggedCursor }),
      ).rejects.toBeInstanceOf(InvalidTicketCursorError);
    });

    it('refuses a flagged cursor whose sort value is not a timestamp', async () => {
      await expect(
        flagged(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), {
          cursor: cursorWith(['whenever'], STUCK_9H),
        }),
      ).rejects.toBeInstanceOf(InvalidTicketCursorError);
    });
  });

  describe('isolation', () => {
    it('does not show tenant A’s supervisor tenant B’s stuck ticket', async () => {
      const page = await flagged(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'));

      expect(page.items.map((ticket) => ticket.id)).not.toContain(TENANT_B_STUCK);
    });

    it('shows tenant B only its own', async () => {
      const page = await flagged(principalFor(TENANT_B, SUPERVISOR_B, 'supervisor'));

      expect(page.items.map((ticket) => ticket.id)).toEqual([TENANT_B_STUCK]);
    });

    it('is not a way for an agent to browse the tenant’s untriaged backlog', async () => {
      // Without `ticket:read_all` the scope is narrowed to `assigned`, and a
      // deferred ticket is by definition assigned to nobody — so the filter that
      // is a supervisor's landing view is an empty page for an agent rather than
      // a 403.
      const page = await flagged(principalFor(TENANT_A, AGENT_A, 'agent'));

      expect(page.items).toEqual([]);
    });
  });
});

async function seedFixture(systemPrisma: PrismaClient): Promise<void> {
  const now = Date.now();

  await systemPrisma.tenant.createMany({
    data: [
      { id: TENANT_A, slug: `${FIXTURE_PREFIX}-a`, name: 'TAR-365 A', status: 'active' },
      { id: TENANT_B, slug: `${FIXTURE_PREFIX}-b`, name: 'TAR-365 B', status: 'active' },
    ],
  });

  await systemPrisma.user.createMany({
    data: [
      {
        id: SUPERVISOR_A,
        tenantId: TENANT_A,
        email: 'sup-a@tar365.invalid',
        name: 'Sup A',
        role: 'supervisor',
        status: 'active',
      },
      {
        id: AGENT_A,
        tenantId: TENANT_A,
        email: 'a1@tar365.invalid',
        name: 'A1',
        role: 'agent',
        status: 'active',
      },
      {
        id: SUPERVISOR_B,
        tenantId: TENANT_B,
        email: 'sup-b@tar365.invalid',
        name: 'Sup B',
        role: 'supervisor',
        status: 'active',
      },
    ],
  });

  await systemPrisma.team.create({
    data: { id: TEAM_A, tenantId: TENANT_A, name: 'Billing' },
  });

  /**
   * `priority` runs *against* deferral age on purpose: the newest flag is
   * `urgent` and the oldest is `low`, so the flagged order and the queue's order
   * disagree on every row rather than only on the ties.
   *
   * No conversation and one contact each is not required — `tickets.contact_id`
   * is nullable and only `tickets_one_active_per_contact` cares — so the fixture
   * leaves both null and stays about routing state.
   */
  const seeded: SeededTicket[] = [
    {
      id: STUCK_9H,
      priority: 'low',
      status: 'open',
      deferredHoursAgo: 9,
      reason: 'all_at_capacity',
      routingState: 'deferred',
    },
    {
      id: STUCK_7H,
      priority: 'normal',
      status: 'pending',
      deferredHoursAgo: 7,
      reason: 'none_available',
      routingState: 'deferred',
    },
    {
      id: TIED_EARLY,
      priority: 'high',
      status: 'open',
      deferredHoursAgo: 5,
      reason: 'all_at_capacity',
      routingState: 'deferred',
    },
    {
      id: TIED_LATE,
      priority: 'normal',
      status: 'open',
      deferredHoursAgo: 5,
      reason: 'all_at_capacity',
      routingState: 'deferred',
    },
    {
      id: STUCK_TEAM,
      priority: 'high',
      status: 'open',
      deferredHoursAgo: 4,
      reason: 'no_candidate_pool',
      routingState: 'deferred',
      assignedTeamId: TEAM_A,
    },
    {
      id: STUCK_2H,
      priority: 'urgent',
      status: 'open',
      deferredHoursAgo: 2,
      reason: 'none_available',
      routingState: 'deferred',
    },
    {
      id: STUCK_BUT_RESOLVED,
      priority: 'urgent',
      status: 'resolved',
      deferredHoursAgo: 8,
      reason: 'all_at_capacity',
      routingState: 'deferred',
    },
    {
      id: ROUTING_PENDING,
      priority: 'urgent',
      status: 'open',
      deferredHoursAgo: null,
      reason: null,
      routingState: 'pending',
    },
    {
      id: ROUTING_ASSIGNED,
      priority: 'urgent',
      status: 'open',
      deferredHoursAgo: null,
      reason: null,
      routingState: 'assigned',
      assignedUserId: AGENT_A,
    },
    {
      id: ROUTING_MANUAL,
      priority: 'urgent',
      status: 'open',
      deferredHoursAgo: null,
      reason: null,
      routingState: 'manual',
      assignedUserId: AGENT_A,
    },
  ];

  await systemPrisma.ticket.createMany({
    data: [
      ...seeded.map((ticket, index) => ({
        id: ticket.id,
        tenantId: TENANT_A,
        number: index + 1,
        status: ticket.status,
        priority: ticket.priority,
        assignedUserId: ticket.assignedUserId ?? null,
        assignedTeamId: ticket.assignedTeamId ?? null,
        routingState: ticket.routingState,
        routingDeferredReason: ticket.reason,
        routingDeferredSince:
          ticket.deferredHoursAgo === null
            ? null
            : new Date(now - ticket.deferredHoursAgo * HOUR_MS),
        // Newest-flagged first, so the queue's `created_at DESC` disagrees with
        // the flagged order as well as its `priority DESC` does.
        createdAt: new Date(now - (ticket.deferredHoursAgo ?? 12) * HOUR_MS),
        resolvedAt: ticket.status === 'resolved' ? new Date(now - HOUR_MS) : null,
      })),
      {
        id: TENANT_B_STUCK,
        tenantId: TENANT_B,
        number: 1,
        status: 'open',
        priority: 'urgent',
        routingState: 'deferred',
        routingDeferredReason: 'none_available',
        routingDeferredSince: new Date(now - 10 * HOUR_MS),
        createdAt: new Date(now - 10 * HOUR_MS),
      },
    ],
  });

  // Past every seeded `number`, so nothing that allocates one can collide.
  await systemPrisma.ticketCounter.createMany({
    data: [
      { tenantId: TENANT_A, nextNumber: NEXT_TICKET_NUMBER },
      { tenantId: TENANT_B, nextNumber: NEXT_TICKET_NUMBER },
    ],
  });
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
