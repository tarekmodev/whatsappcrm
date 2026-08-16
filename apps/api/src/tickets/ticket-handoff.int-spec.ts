import { EventEmitter2 } from '@nestjs/event-emitter';
import { permissionsForRole, type SessionPrincipal, type TenantRole } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import type { QueueService } from '../queue/queue.service';
import { EscalationAlertService } from './escalation-alert.service';
import { TicketCommandService } from './ticket-command.service';
import { TicketEventQueryService } from './ticket-event-query.service';
import { TicketQueryService } from './ticket-query.service';
import {
  EscalationAlertNotFoundError,
  TicketHandoffNotPermittedError,
  TicketNotFoundError,
  TicketReasonRequiredError,
  UnknownEscalationRecipientError,
} from './tickets.errors';

/**
 * TAR-32 end to end against a real PostgreSQL with TAR-48's policies applied,
 * running as `whatsappcrm_app` — the role holding no `BYPASSRLS`.
 *
 * The unit specs prove the rules. Only this can prove the claims that live in
 * the database rather than in TypeScript, and they are the ones ADR 0011 asks a
 * reviewer to check rather than assume:
 *
 *   * **the handoff bound is real.** ⚠️ 0011 decision 2 names this as the review
 *     item: `POST /tickets/{id}/assign` declares `ticket:handoff`, which every
 *     role holds, so a route whose declared permission is weaker than one of its
 *     behaviours is where an authorization bug would live. An agent reassigning
 *     a colleague's ticket must be refused, and the "is the target a teammate"
 *     question is a `team_members` read that a mock cannot answer honestly;
 *   * **the escalation is one transaction.** The `escalated` event and its
 *     `notifications` rows commit together or not at all — a composite foreign
 *     key `(tenant_id, ticket_event_id)` and the
 *     `notifications_escalation_columns` CHECK are what make that structural,
 *     and neither exists in a stub;
 *   * **no cross-tenant reach exists.** A neighbour's ticket is invisible under
 *     RLS before any permission is considered, and a `toUserId` from another
 *     tenant is `validation_failed` on the field rather than a foreign-key
 *     violation surfacing as a 500.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Two fixture
 * tenants with fixed ids and a `tar469-fixture` slug, deleted before the run as
 * well as after it, so an interrupted run cleans up on the next one. Point
 * `pnpm test:db` at a local or disposable database.
 *
 * Prerequisites — the four commands in the README:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '25694444-4444-7444-8444-444444444401';
const TENANT_B = '25694444-4444-7444-8444-444444444402';
/** No supervisor and no admin at all — the tenant an escalation reaches nobody in. */
const TENANT_C = '25694444-4444-7444-8444-444444444403';

const SUPERVISOR_A = '25694444-4444-7444-8444-4444444444d0';
const AGENT_A = '25694444-4444-7444-8444-4444444444d1';
/** Shares `TEAM_A` with `AGENT_A`, so a handoff to them is a handoff to a teammate. */
const MATE_A = '25694444-4444-7444-8444-4444444444d2';
/** Same tenant, no team — the colleague an agent may not hand work to. */
const OUTSIDER_A = '25694444-4444-7444-8444-4444444444d3';
/** A second supervisor, in no team, so the fallback branch has somebody to reach. */
const SUPERVISOR_A2 = '25694444-4444-7444-8444-4444444444d4';
/** Holds `ticket:read_all` by role and cannot act: an escalation may not name them. */
const SUSPENDED_SUPERVISOR_A = '25694444-4444-7444-8444-4444444444d5';
const SUPERVISOR_B = '25694444-4444-7444-8444-4444444444d8';
const AGENT_B = '25694444-4444-7444-8444-4444444444d9';
const AGENT_C = '25694444-4444-7444-8444-4444444444da';

const TEAM_A = '25694444-4444-7444-8444-4444444444b1';
const TEAM_B = '25694444-4444-7444-8444-4444444444b9';

/** Held by `AGENT_A`, which is what makes a reassignment of it a handoff. */
const HELD = '25694444-4444-7444-8444-4444444444f1';
/** Unassigned and flagged — the supervisor's placement, which needs no reason. */
const UNHELD = '25694444-4444-7444-8444-4444444444f2';
/** Held by `MATE_A`: a colleague's ticket, which `AGENT_A` may see but not move. */
const COLLEAGUES = '25694444-4444-7444-8444-4444444444f3';
const TENANT_B_TICKET = '25694444-4444-7444-8444-4444444444f8';
const TENANT_C_TICKET = '25694444-4444-7444-8444-4444444444f9';

const REQUEST_ID = 'tar469-int-spec';
const FIXTURE_PREFIX = 'tar469-fixture';

const DEFERRED_SINCE = new Date('2026-08-15T08:00:00.000Z');

function principalFor(
  tenantId: string,
  userId: string,
  role: TenantRole,
  teamIds: readonly string[] = [],
): SessionPrincipal {
  return {
    userId,
    tenantId,
    email: `${userId}@example.invalid`,
    displayName: 'Fixture user',
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [...teamIds],
    sessionId: userId,
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

describe('handing a ticket on and escalating it, end to end', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let tickets: TicketQueryService;
  let commands: TicketCommandService;
  let ticketEvents: TicketEventQueryService;
  let escalations: EscalationAlertService;

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

  /** The agent who holds `HELD`, in `TEAM_A` with `MATE_A`. */
  function agentA(): SessionPrincipal {
    return principalFor(TENANT_A, AGENT_A, 'agent', [TEAM_A]);
  }

  function supervisorA(): SessionPrincipal {
    return principalFor(TENANT_A, SUPERVISOR_A, 'supervisor', [TEAM_A]);
  }

  function eventsOn(ticketId: string): Promise<{ type: string; actorUserId: string | null }[]> {
    return as(supervisorA(), async () =>
      tenantPrisma.ticketEvent.findMany({
        where: { ticketId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { type: true, actorUserId: true },
      }),
    );
  }

  function notificationsOn(
    ticketId: string,
  ): Promise<{ recipientUserId: string; ticketEventId: string | null }[]> {
    return as(supervisorA(), async () =>
      tenantPrisma.notification.findMany({
        where: { ticketId, type: 'escalation' },
        orderBy: { recipientUserId: 'asc' },
        select: { recipientUserId: true, ticketEventId: true },
      }),
    );
  }

  async function removeFixture(): Promise<void> {
    const tenants = await systemPrisma.tenant.findMany({
      where: { slug: { startsWith: FIXTURE_PREFIX } },
      select: { id: true },
    });
    const tenantIds = tenants.map((tenant) => tenant.id);

    // `notifications.recipient_user_id` references `users` with `onDelete:
    // NoAction` — the convention every user reference in this schema follows,
    // because removing a user is a status change and never a row delete. So the
    // alerts have to go before the tenant, or the cascade is refused. Everything
    // else below a tenant cascades from it.
    await systemPrisma.notification.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await systemPrisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  }

  /** Re-seeded before every case, so none of them depends on another having run. */
  async function seedTickets(): Promise<void> {
    const tenantIds = [TENANT_A, TENANT_B, TENANT_C];

    await systemPrisma.notification.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await systemPrisma.ticketEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await systemPrisma.ticket.deleteMany({ where: { tenantId: { in: tenantIds } } });

    await systemPrisma.ticket.createMany({
      data: [
        { id: HELD, tenantId: TENANT_A, number: 1, status: 'open', assignedUserId: AGENT_A },
        {
          id: UNHELD,
          tenantId: TENANT_A,
          number: 2,
          status: 'open',
          routingState: 'deferred',
          routingDeferredReason: 'all_at_capacity',
          routingDeferredSince: DEFERRED_SINCE,
        },
        {
          id: COLLEAGUES,
          tenantId: TENANT_A,
          number: 3,
          status: 'open',
          assignedUserId: MATE_A,
          // Routed to the team as well, which is what makes it *visible* to
          // `AGENT_A` under `isVisible` — the case the bound exists for is a
          // ticket an agent can see and still may not move.
          assignedTeamId: TEAM_A,
        },
        { id: TENANT_B_TICKET, tenantId: TENANT_B, number: 1, status: 'open' },
        {
          id: TENANT_C_TICKET,
          tenantId: TENANT_C,
          number: 1,
          status: 'open',
          assignedUserId: AGENT_C,
        },
      ],
    });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    tickets = new TicketQueryService(tenantPrisma, tenantContext);
    escalations = new EscalationAlertService(tenantPrisma, tenantContext);
    ticketEvents = new TicketEventQueryService(tenantPrisma, tickets);
    commands = new TicketCommandService(
      tenantPrisma,
      tickets,
      tenantContext,
      new EventEmitter2(),
      // No Redis in this suite, and none needed: neither a handoff nor an
      // escalation is a status change, so 0006's fourth SLA trigger never fires.
      stubQueue(),
      escalations,
    );

    await removeFixture();
    await seedFixture(systemPrisma);
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(seedTickets);

  describe('the reason a reassignment requires', () => {
    it('refuses a handoff of a held ticket with no reason, and writes nothing', async () => {
      await expect(
        as(agentA(), async () => commands.assign(HELD, { userId: MATE_A })),
      ).rejects.toBeInstanceOf(TicketReasonRequiredError);

      expect(await eventsOn(HELD)).toEqual([]);
    });

    it('logs the reason onto the ticket history when one is given', async () => {
      await as(agentA(), async () =>
        commands.assign(HELD, { userId: MATE_A, reason: 'Going off shift' }),
      );

      // Read as the supervisor, and that is the visibility rule working rather
      // than a convenience: the agent handed the ticket to a colleague with no
      // team on it, so it is no longer theirs to open — and the history is not a
      // side channel onto a ticket the detail read would answer `not_found` for.
      const page = await as(supervisorA(), async () => ticketEvents.list(HELD, { limit: 25 }));

      expect(page.items).toEqual([
        expect.objectContaining({
          type: 'assigned',
          actorUserId: AGENT_A,
          reason: 'Going off shift',
          cause: 'agent',
          assignment: {
            fromUserId: AGENT_A,
            fromTeamId: null,
            toUserId: MATE_A,
            toTeamId: null,
          },
        }),
      ]);
    });

    it('accepts a placement of an unheld ticket with no reason', async () => {
      // The asymmetry is the design: a supervisor emptying the flagged queue is
      // placing work nobody held, which is not a handoff.
      const placed = await as(supervisorA(), async () =>
        commands.assign(UNHELD, { userId: MATE_A }),
      );

      expect(placed.assignedUserId).toBe(MATE_A);
      expect(placed.routing.state).toBe('manual');
    });
  });

  describe('the handoff bound', () => {
    it('lets an agent hand their own ticket to a teammate', async () => {
      const handed = await as(agentA(), async () =>
        commands.assign(HELD, { userId: MATE_A, reason: 'Going off shift' }),
      );

      expect(handed.assignedUserId).toBe(MATE_A);
    });

    it('refuses an agent reassigning a ticket a colleague holds', async () => {
      // Visible to them — same team — and still not theirs to move.
      await expect(
        as(agentA(), async () => commands.assign(COLLEAGUES, { userId: AGENT_A, reason: 'Mine' })),
      ).rejects.toBeInstanceOf(TicketHandoffNotPermittedError);

      expect(await eventsOn(COLLEAGUES)).toEqual([]);
    });

    it('refuses a target who shares no team with the caller', async () => {
      // The `team_members` read is what answers this, which is why it is here
      // rather than only in the unit spec.
      await expect(
        as(agentA(), async () =>
          commands.assign(HELD, { userId: OUTSIDER_A, reason: 'Take this' }),
        ),
      ).rejects.toBeInstanceOf(TicketHandoffNotPermittedError);

      expect(await eventsOn(HELD)).toEqual([]);
    });

    it('refuses a team the caller is not in', async () => {
      const teamless = principalFor(TENANT_A, AGENT_A, 'agent');

      await expect(
        as(teamless, async () => commands.assign(HELD, { teamId: TEAM_A, reason: 'Billing' })),
      ).rejects.toBeInstanceOf(TicketHandoffNotPermittedError);
    });

    it('refuses an agent releasing their own ticket, and lets a supervisor do it', async () => {
      await expect(
        as(agentA(), async () => commands.assign(HELD, { userId: null, reason: 'Not mine' })),
      ).rejects.toBeInstanceOf(TicketHandoffNotPermittedError);

      const released = await as(supervisorA(), async () =>
        commands.assign(HELD, { userId: null, reason: 'Back to the pool' }),
      );

      expect(released.assignedUserId).toBeNull();
      expect(released.routing.state).toBe('pending');
    });

    it('does not let a neighbour’s agent reach the ticket at all', async () => {
      // `not_found` rather than `forbidden`, and it never gets as far as the
      // bound: RLS makes tenant A's row invisible to tenant B.
      await expect(
        as(principalFor(TENANT_B, AGENT_B, 'agent'), async () =>
          commands.assign(HELD, { userId: AGENT_B, reason: 'Reaching over' }),
        ),
      ).rejects.toBeInstanceOf(TicketNotFoundError);

      expect(await eventsOn(HELD)).toEqual([]);
    });
  });

  describe('escalating to a supervisor', () => {
    it('writes one event and one notification per recipient, referencing it', async () => {
      const result = await as(agentA(), async () =>
        commands.escalate(HELD, { reason: 'Customer is threatening chargeback' }),
      );

      const events = await eventsOn(HELD);
      const notifications = await notificationsOn(HELD);

      expect(events).toEqual([{ type: 'escalated', actorUserId: AGENT_A }]);
      // Narrowed to the team holding the ticket: `SUPERVISOR_A` shares `TEAM_A`
      // with the holder, `SUPERVISOR_A2` does not, so the fallback does not fire.
      expect(result.notifiedUserIds).toEqual([SUPERVISOR_A]);
      expect(notifications).toEqual([
        { recipientUserId: SUPERVISOR_A, ticketEventId: result.event.id },
      ]);
    });

    it('does not move the assignment', async () => {
      await as(agentA(), async () => commands.escalate(HELD, { reason: 'Needs a decision' }));

      const after = await as(agentA(), async () => tickets.get(HELD));

      expect(after.assignedUserId).toBe(AGENT_A);
      expect(after.routing.state).toBe('pending');
    });

    it('publishes the escalation on the ticket history', async () => {
      await as(agentA(), async () =>
        commands.escalate(HELD, { reason: 'Refund decision needed', toUserId: SUPERVISOR_A }),
      );

      const page = await as(agentA(), async () => ticketEvents.list(HELD, { limit: 25 }));

      expect(page.items).toEqual([
        expect.objectContaining({
          type: 'escalated',
          actorUserId: AGENT_A,
          reason: 'Refund decision needed',
          // The named supervisor. Null here would mean "whoever supervises this
          // ticket", and a console renders the two differently.
          toValue: SUPERVISOR_A,
          assignment: null,
        }),
      ]);
    });

    it('falls back to every candidate when nobody shares the holder’s team', async () => {
      // `UNHELD` is held by nobody, so there is no team to narrow to — an alert
      // delivered to nobody is worse than a broad one.
      const result = await as(supervisorA(), async () =>
        commands.escalate(UNHELD, { reason: 'This has been stuck for a day' }),
      );

      expect([...result.notifiedUserIds].sort()).toEqual([SUPERVISOR_A, SUPERVISOR_A2].sort());
    });

    it('records the escalation and notifies nobody in a tenant with no supervisor', async () => {
      // Not an error: the agent did nothing wrong and has no way to fix it.
      const result = await as(principalFor(TENANT_C, AGENT_C, 'agent'), async () =>
        commands.escalate(TENANT_C_TICKET, { reason: 'Nobody is on call' }),
      );

      expect(result.notifiedUserIds).toEqual([]);
      expect(result.event.type).toBe('escalated');

      const written = await as(principalFor(TENANT_C, AGENT_C, 'agent'), async () =>
        tenantPrisma.ticketEvent.count({ where: { ticketId: TENANT_C_TICKET } }),
      );

      expect(written).toBe(1);
    });

    it('refuses a toUserId from the neighbouring tenant, and writes nothing', async () => {
      await expect(
        as(agentA(), async () =>
          commands.escalate(HELD, { reason: 'Reaching over', toUserId: SUPERVISOR_B }),
        ),
      ).rejects.toBeInstanceOf(UnknownEscalationRecipientError);

      expect(await eventsOn(HELD)).toEqual([]);
      expect(await notificationsOn(HELD)).toEqual([]);
    });

    it('refuses a toUserId who does not hold ticket:read_all', async () => {
      // Requiring it is what makes the notification safe to send: the recipient
      // can already read the ticket, so telling them about it exposes nothing.
      await expect(
        as(agentA(), async () => commands.escalate(HELD, { reason: 'Look', toUserId: MATE_A })),
      ).rejects.toBeInstanceOf(UnknownEscalationRecipientError);
    });

    it('refuses a toUserId who cannot act', async () => {
      await expect(
        as(agentA(), async () =>
          commands.escalate(HELD, { reason: 'Look', toUserId: SUSPENDED_SUPERVISOR_A }),
        ),
      ).rejects.toBeInstanceOf(UnknownEscalationRecipientError);
    });

    it('lets a second escalation notify again', async () => {
      // A second ask an hour after the first is a legitimate act, and swallowing
      // it would make the button lie in the situation it exists for.
      await as(agentA(), async () => commands.escalate(HELD, { reason: 'First ask' }));
      const second = await as(agentA(), async () =>
        commands.escalate(HELD, { reason: 'Still nothing' }),
      );

      expect(second.notifiedUserIds).toEqual([SUPERVISOR_A]);
      expect(await eventsOn(HELD)).toHaveLength(2);
      expect(await notificationsOn(HELD)).toHaveLength(2);
    });

    it('is invisible from the neighbouring tenant', async () => {
      await expect(
        as(principalFor(TENANT_B, AGENT_B, 'agent'), async () =>
          commands.escalate(HELD, { reason: 'Reaching over' }),
        ),
      ).rejects.toBeInstanceOf(TicketNotFoundError);
    });
  });

  describe('the ticket history read', () => {
    it('answers not_found for a ticket the principal may not see', async () => {
      // The log inherits the ticket's visibility rule exactly rather than
      // becoming a side channel onto one.
      await expect(
        as(principalFor(TENANT_B, AGENT_B, 'agent'), async () =>
          ticketEvents.list(HELD, { limit: 25 }),
        ),
      ).rejects.toBeInstanceOf(TicketNotFoundError);
    });

    it('pages newest first and resumes on its cursor without losing a row', async () => {
      await as(agentA(), async () => commands.escalate(HELD, { reason: 'First ask' }));
      await as(agentA(), async () => commands.escalate(HELD, { reason: 'Second ask' }));
      await as(agentA(), async () => commands.escalate(HELD, { reason: 'Third ask' }));

      const first = await as(agentA(), async () => ticketEvents.list(HELD, { limit: 2 }));
      const second = await as(agentA(), async () =>
        ticketEvents.list(HELD, { limit: 2, cursor: first.nextCursor ?? undefined }),
      );

      expect(first.items.map((event) => event.reason)).toEqual(['Third ask', 'Second ask']);
      expect(first.nextCursor).not.toBeNull();
      expect(second.items.map((event) => event.reason)).toEqual(['First ask']);
      expect(second.nextCursor).toBeNull();
    });
  });

  describe('the supervisor’s escalation queue', () => {
    it('lists only the calling principal’s own alerts', async () => {
      await as(agentA(), async () => commands.escalate(HELD, { reason: 'Chargeback risk' }));

      const mine = await as(supervisorA(), async () =>
        escalations.list({ limit: 25, unacknowledgedOnly: true }),
      );
      const theirs = await as(principalFor(TENANT_A, SUPERVISOR_A2, 'supervisor'), async () =>
        escalations.list({ limit: 25, unacknowledgedOnly: true }),
      );

      expect(mine.items).toEqual([
        expect.objectContaining({
          ticketId: HELD,
          ticketNumber: 1,
          raisedByUserId: AGENT_A,
          reason: 'Chargeback risk',
          assignedUserId: AGENT_A,
          acknowledgedAt: null,
        }),
      ]);
      expect(theirs.items).toEqual([]);
    });

    it('is empty for an agent, who is never a recipient', async () => {
      await as(agentA(), async () => commands.escalate(HELD, { reason: 'Chargeback risk' }));

      const page = await as(agentA(), async () =>
        escalations.list({ limit: 25, unacknowledgedOnly: true }),
      );

      expect(page.items).toEqual([]);
    });

    it('acknowledges once, and a second call is not a conflict', async () => {
      await as(agentA(), async () => commands.escalate(HELD, { reason: 'Chargeback risk' }));

      const [alert] = (
        await as(supervisorA(), async () =>
          escalations.list({ limit: 25, unacknowledgedOnly: true }),
        )
      ).items;

      const first = await as(supervisorA(), async () => escalations.acknowledge(alert!.id));
      const again = await as(supervisorA(), async () => escalations.acknowledge(alert!.id));

      expect(first.acknowledgedAt).not.toBeNull();
      // First write wins: the timestamp answers "when did you see this", and two
      // tabs clicking at once must not move it.
      expect(again.acknowledgedAt).toBe(first.acknowledgedAt);
    });

    it('drops an acknowledged alert from the default list', async () => {
      await as(agentA(), async () => commands.escalate(HELD, { reason: 'Chargeback risk' }));

      const [alert] = (
        await as(supervisorA(), async () =>
          escalations.list({ limit: 25, unacknowledgedOnly: true }),
        )
      ).items;

      await as(supervisorA(), async () => escalations.acknowledge(alert!.id));

      const landing = await as(supervisorA(), async () =>
        escalations.list({ limit: 25, unacknowledgedOnly: true }),
      );
      const everything = await as(supervisorA(), async () =>
        escalations.list({ limit: 25, unacknowledgedOnly: false }),
      );

      expect(landing.items).toEqual([]);
      expect(everything.items).toHaveLength(1);
    });

    it('answers not_found when another principal acknowledges it', async () => {
      // A 403 would confirm the id names a real alert somebody else was sent.
      await as(agentA(), async () => commands.escalate(HELD, { reason: 'Chargeback risk' }));

      const [alert] = (
        await as(supervisorA(), async () =>
          escalations.list({ limit: 25, unacknowledgedOnly: true }),
        )
      ).items;

      await expect(
        as(principalFor(TENANT_A, SUPERVISOR_A2, 'supervisor'), async () =>
          escalations.acknowledge(alert!.id),
        ),
      ).rejects.toBeInstanceOf(EscalationAlertNotFoundError);

      await expect(
        as(principalFor(TENANT_B, SUPERVISOR_B, 'supervisor'), async () =>
          escalations.acknowledge(alert!.id),
        ),
      ).rejects.toBeInstanceOf(EscalationAlertNotFoundError);
    });
  });
});

async function seedFixture(systemPrisma: PrismaClient): Promise<void> {
  await systemPrisma.tenant.createMany({
    data: [
      { id: TENANT_A, slug: `${FIXTURE_PREFIX}-a`, name: 'TAR-469 fixture A', status: 'active' },
      { id: TENANT_B, slug: `${FIXTURE_PREFIX}-b`, name: 'TAR-469 fixture B', status: 'active' },
      { id: TENANT_C, slug: `${FIXTURE_PREFIX}-c`, name: 'TAR-469 fixture C', status: 'active' },
    ],
  });

  await systemPrisma.team.createMany({
    data: [
      { id: TEAM_A, tenantId: TENANT_A, name: 'TAR-469 support' },
      { id: TEAM_B, tenantId: TENANT_B, name: 'TAR-469 neighbours' },
    ],
  });

  await systemPrisma.user.createMany({
    data: [
      user(SUPERVISOR_A, TENANT_A, 'supervisor-a', 'supervisor', 'active'),
      user(SUPERVISOR_A2, TENANT_A, 'supervisor-a2', 'supervisor', 'active'),
      user(SUSPENDED_SUPERVISOR_A, TENANT_A, 'suspended-a', 'supervisor', 'suspended'),
      user(AGENT_A, TENANT_A, 'agent-a', 'agent', 'active'),
      user(MATE_A, TENANT_A, 'mate-a', 'agent', 'active'),
      user(OUTSIDER_A, TENANT_A, 'outsider-a', 'agent', 'active'),
      user(SUPERVISOR_B, TENANT_B, 'supervisor-b', 'supervisor', 'active'),
      user(AGENT_B, TENANT_B, 'agent-b', 'agent', 'active'),
      user(AGENT_C, TENANT_C, 'agent-c', 'agent', 'active'),
    ],
  });

  // `SUPERVISOR_A` shares `TEAM_A` with the agent and their teammate, which is
  // what narrows an escalation to them; `SUPERVISOR_A2` is in no team, so the
  // fallback branch has somebody distinguishable to reach.
  await systemPrisma.teamMember.createMany({
    data: [
      { tenantId: TENANT_A, teamId: TEAM_A, userId: SUPERVISOR_A },
      { tenantId: TENANT_A, teamId: TEAM_A, userId: AGENT_A },
      { tenantId: TENANT_A, teamId: TEAM_A, userId: MATE_A },
    ],
  });

  // Past every seeded `number`, so nothing that allocates one can collide with
  // the fixture on `UNIQUE (tenant_id, number)`.
  await systemPrisma.ticketCounter.createMany({
    data: [
      { tenantId: TENANT_A, nextNumber: 100 },
      { tenantId: TENANT_B, nextNumber: 100 },
      { tenantId: TENANT_C, nextNumber: 100 },
    ],
  });
}

function user(
  id: string,
  tenantId: string,
  slug: string,
  role: 'agent' | 'supervisor',
  status: 'active' | 'suspended',
) {
  return {
    id,
    tenantId,
    email: `tar469-${slug}@fixture.test`,
    name: `TAR-469 ${slug}`,
    role,
    status,
  };
}

/**
 * A `QueueService` with no Redis behind it, which is the state a bare clone runs
 * in. Nothing here should reach it: neither a handoff nor an escalation is a
 * status change.
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
