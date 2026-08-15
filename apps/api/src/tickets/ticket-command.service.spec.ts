import type { EventEmitter2 } from '@nestjs/event-emitter';
import {
  permissionsForRole,
  type Permission,
  type SessionPrincipal,
  type TicketStatus,
} from '@whatsappcrm/contracts';
import { SLA_EVALUATE_TICKET_JOB, SLA_QUEUE } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TICKET_UPDATED_EVENT } from '../events/domain-events';
import type { Prisma } from '../generated/prisma/client';
import type { UserStatus } from '../generated/prisma/enums';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { QueueService } from '../queue/queue.service';
import type { TicketRow } from './ticket.mapper';
import { TicketCommandService } from './ticket-command.service';
import type { TicketQueryService } from './ticket-query.service';
import {
  TicketCloseNotPermittedError,
  TicketStatusChangedConcurrentlyError,
  TicketTransitionNotAllowedError,
  UnknownTicketAssigneeError,
} from './tickets.errors';

/**
 * What the ticket writer decides on its own, and what only it can be asked
 * about: the transition table, the two timestamps, the `ticket:close` check, the
 * events a change appends — and the compare-and-set that makes an agent's PATCH
 * safe beside the customer-reply reopen.
 *
 * The database is stubbed here on purpose. That the isolation, the index and the
 * race are real is `ticket-queue.int-spec.ts`'s job against a real PostgreSQL;
 * what this file proves is the *rules* — including that a no-op writes nothing
 * at all, which is invisible in an integration test that only reads the row
 * back.
 */

const TENANT = '25444444-4444-7444-8444-444444444401';
const TICKET = '25444444-4444-7444-8444-4444444444f1';
const AGENT = '25444444-4444-7444-8444-4444444444d1';
/** The supervisor's chosen assignee, and the one who can actually take work. */
const TEAMMATE = '25444444-4444-7444-8444-4444444444d2';
const SUSPENDED = '25444444-4444-7444-8444-4444444444d3';
/** In another tenant, so RLS makes the tenant-scoped lookup answer nothing. */
const STRANGER = '25444444-4444-7444-8444-4444444444d9';
const TEAM = '25444444-4444-7444-8444-4444444444b1';
const OTHER_TENANT_TEAM = '25444444-4444-7444-8444-4444444444b9';

/** Every status, so a loop over the ❌ cells cannot silently skip one. */
const STATUSES: TicketStatus[] = ['open', 'pending', 'resolved', 'closed'];

interface Emission {
  readonly event: string;
  readonly payload: unknown;
}

interface AppendedEvent {
  readonly type: string;
  readonly actorUserId: string | null;
  readonly data: unknown;
}

interface Harness {
  /** Everything put on the in-process bus, in order. */
  readonly emitted: Emission[];
  /** Every `QueueService.enqueue` call — TAR-26's durable status-change trigger. */
  readonly enqueue: jest.Mock;
  /** Every row appended to `ticket_events`, in order. */
  readonly appended: AppendedEvent[];
  /** The `data` of every `updateMany` the writer issued — empty when it wrote nothing. */
  readonly written: Prisma.TicketUncheckedUpdateInput[];
  readonly asAgent: <T>(work: (commands: TicketCommandService) => Promise<T>) => Promise<T>;
}

function ticket(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    id: TICKET,
    number: 41,
    conversationId: '25444444-4444-7444-8444-4444444444e1',
    contactId: '25444444-4444-7444-8444-4444444444c1',
    subject: null,
    status: 'open',
    priority: 'normal',
    assignedUserId: AGENT,
    assignedTeamId: null,
    // The column default. Routing has no writer until TAR-288's router, and a
    // status or priority change is not a routing decision, so nothing in this
    // service moves it.
    routingState: 'pending',
    routingDeferredReason: null,
    routingDeferredSince: null,
    firstRespondedAt: null,
    resolvedAt: null,
    closedAt: null,
    createdAt: new Date('2026-08-11T08:00:00.000Z'),
    updatedAt: new Date('2026-08-11T09:00:00.000Z'),
    // No timers: TAR-26 makes the SLA block a real read of `sla_timers`, and a
    // ticket in a tenant that has SLA turned off legitimately has none. The
    // mapper answers `not_applicable` for that, which is exactly what this
    // fixture asserted back when the block was a fixed placeholder.
    slaTimers: [],
    ...overrides,
  };
}

/** The flagged ticket the supervisor's queue is built from (0008 decision 3). */
function deferredTicket(overrides: Partial<TicketRow> = {}): TicketRow {
  return ticket({
    assignedUserId: null,
    assignedTeamId: null,
    routingState: 'deferred',
    routingDeferredReason: 'all_at_capacity',
    routingDeferredSince: new Date('2026-08-14T08:00:00.000Z'),
    ...overrides,
  });
}

function principalWith(permissions: readonly Permission[]): SessionPrincipal {
  return {
    userId: AGENT,
    tenantId: TENANT,
    email: 'agent@example.invalid',
    displayName: 'Fixture agent',
    role: 'agent',
    permissions: [...permissions],
    teamIds: [],
    sessionId: AGENT,
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

/** This tenant's users, as the tenant-scoped lookup in `assign` can see them. */
const TENANT_USERS: readonly { id: string; status: UserStatus }[] = [
  { id: AGENT, status: 'active' },
  { id: TEAMMATE, status: 'active' },
  { id: SUSPENDED, status: 'suspended' },
];

const TENANT_TEAMS: readonly string[] = [TEAM];

/** An agent holds `ticket:update` and `ticket:close` today; 0006 §7 relies on that. */
const FULL_PERMISSIONS = permissionsForRole('agent');
const WITHOUT_CLOSE = FULL_PERMISSIONS.filter((permission) => permission !== 'ticket:close');

/**
 * The writer with its transaction stubbed.
 *
 * `matched` is what the compare-and-set is told it hit: `1` for the ordinary
 * case, `0` for the ticket whose status moved underneath the request — which is
 * exactly what PostgreSQL answers when the linker's reopen commits first.
 *
 * The row read back is derived from what the writer asked to be written rather
 * than hard-coded, so an assertion about `resolvedAt` is an assertion about the
 * statement and not about the stub.
 */
function harnessFor(
  before: TicketRow,
  options: { matched?: number; permissions?: readonly Permission[] } = {},
): Harness {
  const { matched = 1, permissions = FULL_PERMISSIONS } = options;
  const emitted: Emission[] = [];
  const appended: AppendedEvent[] = [];
  const written: Prisma.TicketUncheckedUpdateInput[] = [];
  const tenantContext = new TenantContextService();

  const tx = {
    ticket: {
      updateMany: ({ data }: { data: Prisma.TicketUncheckedUpdateInput }) => {
        written.push(data);
        return Promise.resolve({ count: matched });
      },
      findUniqueOrThrow: (): Promise<TicketRow> =>
        Promise.resolve({ ...before, ...(written.at(-1) as Partial<TicketRow>) }),
    },
    ticketEvent: {
      create: ({ data }: { data: AppendedEvent }) => {
        appended.push({ type: data.type, actorUserId: data.actorUserId, data: data.data });
        return Promise.resolve(data);
      },
    },
  };

  // The two reads `assign` makes before it writes. They stand for a
  // **tenant-scoped** lookup: `STRANGER` and `OTHER_TENANT_TEAM` are simply not
  // in these tables, which is what RLS does to another tenant's row, and the
  // `status` filter is applied here because the real `findUnique` carries it.
  const prisma = {
    $tenantTransaction: <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx),
    user: {
      findUnique: ({ where }: { where: { id: string; status?: UserStatus } }) =>
        Promise.resolve(
          TENANT_USERS.find(
            (user) =>
              user.id === where.id && (where.status === undefined || user.status === where.status),
          ) ?? null,
        ),
    },
    team: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(TENANT_TEAMS.includes(where.id) ? { id: where.id } : null),
    },
  } as unknown as TenantPrisma;

  // `require` keeps no rule of its own here: the visibility check it really
  // makes is exercised against a real database in the int-spec, and stubbing it
  // to the row under test is what lets these cases be about the transition.
  const tickets = {
    require: (): Promise<TicketRow> => Promise.resolve(before),
  } as unknown as TicketQueryService;

  const events = {
    emit: (event: string, payload: unknown): boolean => {
      emitted.push({ event, payload });
      return true;
    },
  } as unknown as EventEmitter2;

  // TAR-26's fourth trigger. Recorded rather than asserted here — what a status
  // change does to a timer is `sla-breach.int-spec.ts`'s business; what this
  // file cares about is that a durable job is produced at all, and only when the
  // status actually moved.
  const enqueue = jest.fn(() => Promise.resolve('added'));
  const queue = { enqueue } as unknown as QueueService;

  const commands = new TicketCommandService(prisma, tickets, tenantContext, events, queue);

  return {
    emitted,
    enqueue,
    appended,
    written,
    asAgent: async (work) =>
      await tenantContext.run(
        {
          requestId: 'spec',
          tenantId: TENANT,
          userId: AGENT,
          principal: principalWith(permissions),
        },
        async () => await work(commands),
      ),
  };
}

describe('the ticket transition table', () => {
  it.each([
    ['resolved' as const, 'open' as const],
    ['resolved' as const, 'pending' as const],
    ['closed' as const, 'open' as const],
    ['closed' as const, 'pending' as const],
    ['closed' as const, 'resolved' as const],
  ])('refuses %s → %s as a conflict', async (from, to) => {
    const { asAgent, written } = harnessFor(ticket({ status: from }));

    await expect(
      asAgent(async (commands) => commands.update(TICKET, { status: to })),
    ).rejects.toBeInstanceOf(TicketTransitionNotAllowedError);
    // Refused before the transaction, not rolled back out of it.
    expect(written).toEqual([]);
  });

  it.each([
    ['open' as const, 'pending' as const],
    ['open' as const, 'resolved' as const],
    ['open' as const, 'closed' as const],
    ['pending' as const, 'open' as const],
    ['pending' as const, 'resolved' as const],
    ['pending' as const, 'closed' as const],
    ['resolved' as const, 'closed' as const],
  ])('allows %s → %s', async (from, to) => {
    const { asAgent, written } = harnessFor(ticket({ status: from }));

    await asAgent(async (commands) => commands.update(TICKET, { status: to }));

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ status: to });
  });

  it.each(STATUSES)('treats setting %s on a ticket already in it as a no-op', async (status) => {
    const { asAgent, written, appended, emitted } = harnessFor(ticket({ status }));

    const response = await asAgent(async (commands) => commands.update(TICKET, { status }));

    // 200 with the current ticket, and nothing written anywhere: a double-click
    // and a retry after a dropped response both arrive as this.
    expect(response.status).toBe(status);
    expect(written).toEqual([]);
    expect(appended).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('treats setting the priority it already has as a no-op', async () => {
    const { asAgent, written, appended } = harnessFor(ticket({ priority: 'urgent' }));

    await asAgent(async (commands) => commands.update(TICKET, { priority: 'urgent' }));

    expect(written).toEqual([]);
    expect(appended).toEqual([]);
  });
});

describe('resolvedAt and closedAt', () => {
  it('records resolvedAt on entering resolved, and leaves closedAt alone', async () => {
    const { asAgent, written } = harnessFor(ticket({ status: 'open' }));

    await asAgent(async (commands) => commands.update(TICKET, { status: 'resolved' }));

    expect(written[0]?.resolvedAt).toBeInstanceOf(Date);
    expect(written[0]).not.toHaveProperty('closedAt');
  });

  it('leaves resolvedAt null when an open ticket is closed without being resolved', async () => {
    // Closing spam or a wrong number is not a resolution, and TAR-30's
    // cycle-time reporting reads this column — `closed_at IS NOT NULL AND
    // resolved_at IS NULL` is the honest signal for "closed unworked".
    const { asAgent, written } = harnessFor(ticket({ status: 'open' }));

    const response = await asAgent(async (commands) =>
      commands.update(TICKET, { status: 'closed' }),
    );

    expect(written[0]?.closedAt).toBeInstanceOf(Date);
    expect(written[0]).not.toHaveProperty('resolvedAt');
    expect(response.resolvedAt).toBeNull();
  });

  it('keeps the original resolution time when a resolved ticket is closed', async () => {
    const resolvedAt = new Date('2026-08-12T10:00:00.000Z');
    const { asAgent, written } = harnessFor(ticket({ status: 'resolved', resolvedAt }));

    const response = await asAgent(async (commands) =>
      commands.update(TICKET, { status: 'closed' }),
    );

    expect(written[0]).not.toHaveProperty('resolvedAt');
    expect(response.resolvedAt).toBe(resolvedAt.toISOString());
  });
});

describe('the ticket:close permission', () => {
  it.each(['resolved' as const, 'closed' as const])(
    'refuses a move to %s without it',
    async (to) => {
      const { asAgent, written } = harnessFor(ticket({ status: 'open' }), {
        permissions: WITHOUT_CLOSE,
      });

      await expect(
        asAgent(async (commands) => commands.update(TICKET, { status: to })),
      ).rejects.toBeInstanceOf(TicketCloseNotPermittedError);
      expect(written).toEqual([]);
    },
  );

  it.each(['open' as const, 'pending' as const])('does not stand in the way of %s', async (to) => {
    const { asAgent, written } = harnessFor(
      ticket({ status: to === 'open' ? 'pending' : 'open' }),
      {
        permissions: WITHOUT_CLOSE,
      },
    );

    await asAgent(async (commands) => commands.update(TICKET, { status: to }));

    expect(written).toHaveLength(1);
  });

  it('lets a re-prioritisation through without it', async () => {
    const { asAgent, written } = harnessFor(ticket(), { permissions: WITHOUT_CLOSE });

    await asAgent(async (commands) => commands.update(TICKET, { priority: 'urgent' }));

    expect(written[0]).toMatchObject({ priority: 'urgent' });
  });

  it('refuses a transition the table rejects before asking about the permission', async () => {
    // Telling somebody they need `ticket:close` for a move nobody can make would
    // send them after a permission that would not help.
    const { asAgent } = harnessFor(ticket({ status: 'closed' }), { permissions: WITHOUT_CLOSE });

    await expect(
      asAgent(async (commands) => commands.update(TICKET, { status: 'resolved' })),
    ).rejects.toBeInstanceOf(TicketTransitionNotAllowedError);
  });
});

describe('the event log a change writes', () => {
  it('appends one status_changed carrying the agent and the cause', async () => {
    const { asAgent, appended } = harnessFor(ticket({ status: 'open' }));

    await asAgent(async (commands) => commands.update(TICKET, { status: 'pending' }));

    expect(appended).toEqual([
      {
        type: 'status_changed',
        actorUserId: AGENT,
        data: { from: 'open', to: 'pending', cause: 'agent' },
      },
    ]);
  });

  it('appends one row per changed field, and none for the unchanged ones', async () => {
    const { asAgent, appended } = harnessFor(ticket({ status: 'open', priority: 'normal' }));

    await asAgent(async (commands) =>
      commands.update(TICKET, { status: 'pending', priority: 'normal', subject: 'Refund' }),
    );

    // `priority` was already `normal`, and `subject` has no event type.
    expect(appended.map((event) => event.type)).toEqual(['status_changed']);
  });

  it('appends priority_changed with from and to', async () => {
    const { asAgent, appended } = harnessFor(ticket({ priority: 'low' }));

    await asAgent(async (commands) => commands.update(TICKET, { priority: 'urgent' }));

    expect(appended).toEqual([
      {
        type: 'priority_changed',
        actorUserId: AGENT,
        data: { from: 'low', to: 'urgent', cause: 'agent' },
      },
    ]);
  });

  it('never writes a reopened event — pending → open is a status_changed', async () => {
    // 0006 §5: `reopened` is reserved for the resolved-reopen window of 0003,
    // which does not exist at v1. Two event types meaning "the status moved"
    // would make every consumer learn both.
    const { asAgent, appended } = harnessFor(ticket({ status: 'pending' }));

    await asAgent(async (commands) => commands.update(TICKET, { status: 'open' }));

    expect(appended.map((event) => event.type)).toEqual(['status_changed']);
  });
});

describe('the compare-and-set against a concurrent reopen', () => {
  it('answers conflict when the status moved underneath the request', async () => {
    // The customer replied and `TicketLinkerService` moved the ticket
    // `pending → open` between this request's read and its write, so the
    // `WHERE status = 'pending'` matches nothing.
    const { asAgent, appended, emitted } = harnessFor(ticket({ status: 'pending' }), {
      matched: 0,
    });

    await expect(
      asAgent(async (commands) => commands.update(TICKET, { status: 'resolved' })),
    ).rejects.toBeInstanceOf(TicketStatusChangedConcurrentlyError);

    // The transaction rolled back, so the log never claims a transition that
    // did not happen — and nothing was announced.
    expect(appended).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('does not retry the transition against the new status', async () => {
    const { asAgent, written } = harnessFor(ticket({ status: 'pending' }), { matched: 0 });

    await asAgent(async (commands) =>
      commands.update(TICKET, { status: 'resolved' }).catch(() => null),
    );

    // Exactly one attempt. Re-applying "resolve" from `open` would satisfy the
    // click and hide the customer's reply, which is the thing the agent needs
    // to see before resolving.
    expect(written).toHaveLength(1);
  });
});

describe('announcing a ticket change', () => {
  it('carries both the previous and the current status and priority', async () => {
    const { asAgent, emitted } = harnessFor(ticket({ status: 'open', priority: 'low' }));

    await asAgent(async (commands) =>
      commands.update(TICKET, { status: 'pending', priority: 'urgent' }),
    );

    expect(emitted).toEqual([
      {
        event: TICKET_UPDATED_EVENT,
        payload: {
          tenantId: TENANT,
          ticketId: TICKET,
          previousStatus: 'open',
          status: 'pending',
          previousPriority: 'low',
          priority: 'urgent',
          actorUserId: AGENT,
        },
      },
    ]);
  });
});

/**
 * 0006's fourth SLA trigger. It is a **durable queue job**, not the in-process
 * `ticket.updated` above — `domain-events.ts` says a subscriber for which loss
 * is not acceptable needs a durable trigger of its own, and a missed SLA
 * transition leaves a paused clock running or a breach nobody is told about.
 */
describe('the SLA evaluation a status change triggers', () => {
  it('enqueues one durable job naming the ticket and the reason', async () => {
    const { asAgent, enqueue } = harnessFor(ticket({ status: 'open' }));

    await asAgent(async (commands) => commands.update(TICKET, { status: 'pending' }));

    expect(enqueue).toHaveBeenCalledWith(
      SLA_QUEUE,
      SLA_EVALUATE_TICKET_JOB,
      { tenantId: TENANT, ticketId: TICKET, reason: 'status_changed' },
      // No custom `jobId`: a ticket-keyed id silently collapses every trigger
      // after the first into the completed key of the one before it.
      expect.not.objectContaining({ jobId: expect.anything() as unknown }),
    );
  });

  /**
   * A running deadline keeps the policy it started under, which is 0006's rule
   * that a policy change affects future tickets and never past deadlines — so a
   * re-prioritisation moves no timer and is not worth a job.
   */
  it('enqueues nothing when only the priority moved', async () => {
    const { asAgent, enqueue } = harnessFor(ticket({ status: 'open', priority: 'low' }));

    await asAgent(async (commands) => commands.update(TICKET, { priority: 'urgent' }));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues nothing when the request set the status it already had', async () => {
    const { asAgent, enqueue } = harnessFor(ticket({ status: 'open' }));

    await asAgent(async (commands) => commands.update(TICKET, { status: 'open' }));

    expect(enqueue).not.toHaveBeenCalled();
  });

  /**
   * The status change is committed and the caller is owed their 200.
   * `QueueService`'s contract is that an enqueue never fails a caller.
   */
  it('still answers when the job could not be queued', async () => {
    const { asAgent, enqueue } = harnessFor(ticket({ status: 'open' }));

    enqueue.mockResolvedValue('failed');

    await expect(
      asAgent(async (commands) => commands.update(TICKET, { status: 'pending' })),
    ).resolves.toMatchObject({ status: 'pending' });
  });
});

/**
 * `POST /api/v1/tickets/{id}/assign` — the supervisor's manual placement
 * (TAR-23, 0008 decision 3 and amendment 2).
 *
 * The load-bearing assertion in most of these is about the **single statement**:
 * `tickets_routing_deferred_consistent` makes the assignment columns and the
 * three routing ones one indivisible write, so a test that only checked the
 * assignee would pass against a version the database rejects.
 */
describe('assigning a ticket by hand', () => {
  it('puts a user on the ticket and marks routing manual in one statement', async () => {
    const { asAgent, written } = harnessFor(ticket({ assignedUserId: null }));

    const response = await asAgent(async (commands) =>
      commands.assign(TICKET, { userId: TEAMMATE }),
    );

    expect(written).toEqual([
      {
        assignedUserId: TEAMMATE,
        assignedTeamId: null,
        routingState: 'manual',
        routingDeferredReason: null,
        routingDeferredSince: null,
      },
    ]);
    expect(response.assignedUserId).toBe(TEAMMATE);
    expect(response.routing.state).toBe('manual');
  });

  it('routes to a team the same way', async () => {
    const { asAgent, written } = harnessFor(ticket({ assignedUserId: null }));

    const response = await asAgent(async (commands) => commands.assign(TICKET, { teamId: TEAM }));

    expect(written[0]).toMatchObject({ assignedTeamId: TEAM, routingState: 'manual' });
    expect(response.assignedTeamId).toBe(TEAM);
  });

  it('takes a deferred ticket out of the flagged queue, both columns nulled', async () => {
    // The CHECK constraint refuses `routing_state <> 'deferred'` while either
    // column is still set, so this is the write that would fail at the database
    // if the four columns were not moved together.
    const { asAgent, written } = harnessFor(deferredTicket());

    const response = await asAgent(async (commands) =>
      commands.assign(TICKET, { userId: TEAMMATE }),
    );

    expect(written[0]).toMatchObject({
      routingState: 'manual',
      routingDeferredReason: null,
      routingDeferredSince: null,
    });
    expect(response.routing).toEqual({
      state: 'manual',
      deferredReason: null,
      deferredSince: null,
    });
  });

  it('applies one column without clearing the other', async () => {
    // The partial semantics the schema's `.refine` allows and the mock models:
    // absent leaves the column alone.
    const { asAgent, written } = harnessFor(ticket({ assignedUserId: null, assignedTeamId: TEAM }));

    const response = await asAgent(async (commands) =>
      commands.assign(TICKET, { userId: TEAMMATE }),
    );

    expect(written[0]).toMatchObject({ assignedUserId: TEAMMATE, assignedTeamId: TEAM });
    expect(response.assignedTeamId).toBe(TEAM);
  });

  it('sends an explicit release back to pending, not manual', async () => {
    // 0008 amendment 2. Nobody holds it and no supervisor has judged it stuck,
    // which is the state a fresh ticket has — and `pending` is therefore
    // reachable after the insert.
    const { asAgent, written } = harnessFor(deferredTicket());

    const response = await asAgent(async (commands) =>
      commands.assign(TICKET, { userId: null, teamId: null }),
    );

    expect(written[0]).toMatchObject({
      assignedUserId: null,
      assignedTeamId: null,
      routingState: 'pending',
      routingDeferredReason: null,
      routingDeferredSince: null,
    });
    expect(response.routing.state).toBe('pending');
  });

  it('keeps manual when clearing the user leaves the team on the ticket', async () => {
    // `{ userId: null }` is not by itself a release: somebody still holds it.
    const { asAgent, written } = harnessFor(
      ticket({ assignedUserId: AGENT, assignedTeamId: TEAM }),
    );

    await asAgent(async (commands) => commands.assign(TICKET, { userId: null }));

    expect(written[0]).toMatchObject({
      assignedUserId: null,
      assignedTeamId: TEAM,
      routingState: 'manual',
    });
  });

  it('writes nothing when the same assignment is submitted twice', async () => {
    // A double-clicked Assign button, and a retry after a dropped response. The
    // rule `update` states, and here it also keeps the escalation history from
    // growing a second identical `assigned` row.
    const { asAgent, written, appended } = harnessFor(
      ticket({ assignedUserId: TEAMMATE, assignedTeamId: null, routingState: 'manual' }),
    );

    const response = await asAgent(async (commands) =>
      commands.assign(TICKET, { userId: TEAMMATE }),
    );

    expect(written).toEqual([]);
    expect(appended).toEqual([]);
    expect(response.assignedUserId).toBe(TEAMMATE);
  });

  it('still writes when only the routing state would move', async () => {
    // Assigning a deferred ticket to the team it already carries changes no
    // assignment column and still has to leave the flagged queue.
    const { asAgent, written } = harnessFor(deferredTicket({ assignedTeamId: TEAM }));

    await asAgent(async (commands) => commands.assign(TICKET, { teamId: TEAM }));

    expect(written[0]).toMatchObject({ routingState: 'manual', routingDeferredReason: null });
  });
});

describe('the event an assignment appends', () => {
  it('records the actor, the new pair, the previous pair and the reason', async () => {
    const { asAgent, appended } = harnessFor(ticket({ assignedUserId: AGENT }));

    await asAgent(async (commands) =>
      commands.assign(TICKET, { userId: TEAMMATE, reason: 'Ada is at capacity' }),
    );

    expect(appended).toEqual([
      {
        type: 'assigned',
        // A person, unlike the router's system-null actor.
        actorUserId: AGENT,
        data: {
          assignedUserId: TEAMMATE,
          assignedTeamId: null,
          previousAssignedUserId: AGENT,
          previousAssignedTeamId: null,
          cause: 'agent',
          reason: 'Ada is at capacity',
        },
      },
    ]);
  });

  it('omits reason entirely when the body carried none', async () => {
    const { asAgent, appended } = harnessFor(ticket({ assignedUserId: null }));

    await asAgent(async (commands) => commands.assign(TICKET, { userId: TEAMMATE }));

    expect(appended[0]?.data).not.toHaveProperty('reason');
  });

  it('writes unassigned rather than assigned when nobody is left on it', async () => {
    const { asAgent, appended } = harnessFor(ticket({ assignedUserId: AGENT }));

    await asAgent(async (commands) => commands.assign(TICKET, { userId: null }));

    expect(appended.map((event) => event.type)).toEqual(['unassigned']);
  });

  it('announces nothing and enqueues nothing', async () => {
    // `ticket.updated` carries status and priority, neither of which moved, and
    // 0006's fourth SLA trigger is a status change.
    const { asAgent, emitted, enqueue } = harnessFor(ticket({ assignedUserId: null }));

    await asAgent(async (commands) => commands.assign(TICKET, { userId: TEAMMATE }));

    expect(emitted).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('the assignee an assign body names', () => {
  it('refuses a userId from another tenant, and writes nothing', async () => {
    // Invisible to the tenant-scoped lookup, exactly as RLS leaves it — the id
    // in the body is never trusted as a key.
    const { asAgent, written } = harnessFor(deferredTicket());

    await expect(
      asAgent(async (commands) => commands.assign(TICKET, { userId: STRANGER })),
    ).rejects.toBeInstanceOf(UnknownTicketAssigneeError);
    expect(written).toEqual([]);
  });

  it('refuses a user who is not active', async () => {
    // A suspended account has had its access cut: handing it a stuck ticket
    // would look like a fix and be a second deferral.
    const { asAgent, written } = harnessFor(deferredTicket());

    await expect(
      asAgent(async (commands) => commands.assign(TICKET, { userId: SUSPENDED })),
    ).rejects.toBeInstanceOf(UnknownTicketAssigneeError);
    expect(written).toEqual([]);
  });

  it('points the failure at the offending field', async () => {
    const { asAgent } = harnessFor(deferredTicket());

    await expect(
      asAgent(async (commands) => commands.assign(TICKET, { teamId: OTHER_TENANT_TEAM })),
    ).rejects.toMatchObject({ field: 'teamId' });
  });

  it('refuses a teamId from another tenant', async () => {
    const { asAgent, written } = harnessFor(deferredTicket());

    await expect(
      asAgent(async (commands) => commands.assign(TICKET, { teamId: OTHER_TENANT_TEAM })),
    ).rejects.toBeInstanceOf(UnknownTicketAssigneeError);
    expect(written).toEqual([]);
  });
});
