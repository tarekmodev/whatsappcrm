import type { WorkflowAction } from '@whatsappcrm/contracts';
import { Prisma } from '../generated/prisma/client';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type {
  TicketAutomationResult,
  TicketCommandService,
} from '../tickets/ticket-command.service';
import { WorkflowActionExecutor, type ActionContext } from './workflow-action.executor';

/**
 * Every action type, executed — the half of TAR-27's acceptance criteria that
 * the trigger-service spec cannot cover, because it mocks this class out.
 *
 * What matters here is not that the writes happen (the integration suite owns
 * that) but the **translations**: a missing reference becomes
 * `reference_missing` rather than a thrown fault, a repeat becomes `no_op`
 * rather than `applied`, and an audience that resolves to nobody is not a
 * failure. Each of those is a value a supervisor reads off the run row.
 */

const TENANT = '019fed83-0000-7000-8000-00000000e001';
const TICKET = '019fed83-0000-7000-8000-00000000e002';
const WORKFLOW = '019fed83-0000-7000-8000-00000000e003';
const RUN = '019fed83-0000-7000-8000-00000000e004';
const TAG = '019fed83-0000-7000-8000-00000000e005';
const TEAM = '019fed83-0000-7000-8000-00000000e006';
const USER = '019fed83-0000-7000-8000-00000000e007';
const SUPERVISOR = '019fed83-0000-7000-8000-00000000e008';

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    tenantId: TENANT,
    ticketId: TICKET,
    workflowId: WORKFLOW,
    workflowRunId: RUN,
    actionIndex: 0,
    ...overrides,
  };
}

interface PrismaStub {
  /** Rows the tenant-scoped lookups can see. Absent means RLS filtered it out. */
  readonly teams?: readonly string[];
  readonly activeUsers?: readonly string[];
  readonly teamMembers?: readonly string[];
  readonly supervisors?: readonly string[];
  readonly ticket?: { assignedUserId: string | null; assignedTeamId: string | null } | null;
  /** What `ticketTag.createMany` reports having inserted. */
  readonly tagInserted?: number;
  /** Raised by `ticketTag.createMany`, for the foreign-key path. */
  readonly tagError?: Error;
}

interface Harness {
  readonly executor: WorkflowActionExecutor;
  readonly notifications: { recipientUserId: string; dedupeKey: string }[];
  readonly automations: { kind: string }[];
}

function harness(stub: PrismaStub = {}, automation?: TicketAutomationResult): Harness {
  const notifications: { recipientUserId: string; dedupeKey: string }[] = [];
  const automations: { kind: string }[] = [];

  const prisma = {
    team: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve((stub.teams ?? []).includes(where.id) ? { id: where.id } : null),
    },
    user: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve((stub.activeUsers ?? []).includes(where.id) ? { id: where.id } : null),
      findMany: () =>
        Promise.resolve(
          (stub.supervisors ?? []).map((id) => ({
            id,
            teamMemberships: [] as { teamId: string }[],
          })),
        ),
    },
    teamMember: {
      findMany: () => Promise.resolve((stub.teamMembers ?? []).map((userId) => ({ userId }))),
    },
    ticket: { findUnique: () => Promise.resolve(stub.ticket ?? null) },
    ticketTag: {
      createMany: () =>
        stub.tagError === undefined
          ? Promise.resolve({ count: stub.tagInserted ?? 1 })
          : Promise.reject(stub.tagError),
    },
    notification: {
      createMany: ({ data }: { data: { recipientUserId: string; dedupeKey: string }[] }) => {
        notifications.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
  } as unknown as TenantPrisma;

  const tickets = {
    applyAutomation: (_ticketId: string, change: { kind: string }) => {
      automations.push({ kind: change.kind });

      return Promise.resolve(automation ?? { outcome: 'applied' as const, occurrence: null });
    },
  } as unknown as TicketCommandService;

  return { executor: new WorkflowActionExecutor(prisma, tickets), notifications, automations };
}

function foreignKeyViolation(): Error {
  return new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
    code: 'P2003',
    clientVersion: 'test',
  });
}

describe('add_ticket_tag', () => {
  const action: WorkflowAction = { type: 'add_ticket_tag', tagId: TAG };

  it('reports applied when the row was inserted', async () => {
    await expect(harness({ tagInserted: 1 }).executor.execute(action, context())).resolves.toEqual({
      outcome: 'applied',
      reason: null,
      occurrence: null,
    });
  });

  it('reports no_op when the ticket already carried the tag', async () => {
    // `UNIQUE (tenant_id, ticket_id, tag_id)` with `skipDuplicates` is what makes
    // applying a tag twice a no-op rather than a failed run.
    await expect(harness({ tagInserted: 0 }).executor.execute(action, context())).resolves.toEqual({
      outcome: 'no_op',
      reason: null,
      occurrence: null,
    });
  });

  it('turns a foreign-key violation into reference_missing, not internal_error', async () => {
    // The tag was deleted between the claim and this write. The composite FK is
    // the check — a read first would not have caught it — and this mapping is
    // what deactivates the workflow instead of burying it as a fault.
    await expect(
      harness({ tagError: foreignKeyViolation() }).executor.execute(action, context()),
    ).resolves.toEqual({ outcome: 'failed', reason: 'reference_missing', occurrence: null });
  });
});

describe('reassign', () => {
  it('re-reads the target team in tenant scope before writing', async () => {
    const held = harness({ teams: [TEAM] });

    await expect(
      held.executor.execute(
        { type: 'reassign', target: { kind: 'team', teamId: TEAM } },
        context(),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    expect(held.automations).toEqual([{ kind: 'assignment' }]);
  });

  it('fails with reference_missing for a team this tenant cannot see', async () => {
    const held = harness({ teams: [] });

    await expect(
      held.executor.execute(
        { type: 'reassign', target: { kind: 'team', teamId: TEAM } },
        context(),
      ),
    ).resolves.toEqual({ outcome: 'failed', reason: 'reference_missing', occurrence: null });
    // And nothing was written: the refusal is before the ticket write.
    expect(held.automations).toEqual([]);
  });

  it('fails with reference_missing for a user who is no longer active', async () => {
    // 0009 decision 6's fourth mechanism — the case no foreign key covers,
    // because removing a user is permitted on purpose.
    const held = harness({ activeUsers: [] });

    await expect(
      held.executor.execute(
        { type: 'reassign', target: { kind: 'user', userId: USER } },
        context(),
      ),
    ).resolves.toEqual({ outcome: 'failed', reason: 'reference_missing', occurrence: null });
    expect(held.automations).toEqual([]);
  });

  it('carries the occurrence up so the caller can raise a chained trigger', async () => {
    const held = harness(
      { activeUsers: [USER] },
      { outcome: 'applied', occurrence: { triggerType: 'ticket_assigned', ticketEventId: 'ev-1' } },
    );

    await expect(
      held.executor.execute(
        { type: 'reassign', target: { kind: 'user', userId: USER } },
        context(),
      ),
    ).resolves.toMatchObject({
      occurrence: { triggerType: 'ticket_assigned', ticketEventId: 'ev-1' },
    });
  });
});

describe('set_status and set_priority', () => {
  it('maps a refused transition to failed/transition_refused rather than throwing', async () => {
    // A workflow attempting to reopen a closed ticket is a fact about that rule,
    // not a fault — it must never reach the failed job set.
    const held = harness({}, { outcome: 'transition_refused', occurrence: null });

    await expect(
      held.executor.execute({ type: 'set_status', status: 'open' }, context()),
    ).resolves.toEqual({ outcome: 'failed', reason: 'transition_refused', occurrence: null });
  });

  it('maps a vanished ticket to failed/ticket_gone', async () => {
    const held = harness({}, { outcome: 'ticket_gone', occurrence: null });

    await expect(
      held.executor.execute({ type: 'set_priority', priority: 'urgent' }, context()),
    ).resolves.toEqual({ outcome: 'failed', reason: 'ticket_gone', occurrence: null });
  });

  it('reports no_op when the ticket already holds the value', async () => {
    const held = harness({}, { outcome: 'no_op', occurrence: null });

    await expect(
      held.executor.execute({ type: 'set_priority', priority: 'urgent' }, context()),
    ).resolves.toMatchObject({ outcome: 'no_op' });
  });
});

describe('notify', () => {
  const supervisorsAction: WorkflowAction = {
    type: 'notify',
    audience: 'supervisors',
    userId: null,
    teamId: null,
    message: 'Unresolved for four hours',
  };

  it('writes one row per resolved supervisor', async () => {
    const held = harness({
      ticket: { assignedUserId: null, assignedTeamId: null },
      supervisors: [SUPERVISOR],
    });

    await expect(held.executor.execute(supervisorsAction, context())).resolves.toMatchObject({
      outcome: 'applied',
    });
    expect(held.notifications.map((row) => row.recipientUserId)).toEqual([SUPERVISOR]);
  });

  it('is a no_op rather than a failure when the audience resolves to nobody', async () => {
    // The automation ran and there was no audience. That is a fact a supervisor
    // may need, not something to mark the run failed for.
    const held = harness({
      ticket: { assignedUserId: null, assignedTeamId: null },
      supervisors: [],
    });

    await expect(held.executor.execute(supervisorsAction, context())).resolves.toEqual({
      outcome: 'no_op',
      reason: null,
      occurrence: null,
    });
    expect(held.notifications).toEqual([]);
  });

  it('resolves a team audience to its active members', async () => {
    const held = harness({ teamMembers: [USER, SUPERVISOR] });

    await held.executor.execute(
      { type: 'notify', audience: 'team', userId: null, teamId: TEAM, message: null },
      context(),
    );

    expect(held.notifications.map((row) => row.recipientUserId)).toEqual([USER, SUPERVISOR]);
  });

  it('reserves per action, so two notifies in one run both reach a shared recipient', async () => {
    // The regression the review caught. Keyed on the run alone, the second
    // insert for an overlapping recipient is swallowed by `skipDuplicates` and
    // reported `no_op` — which in this vocabulary means "already in that state"
    // rather than "we dropped your message".
    const held = harness({
      ticket: { assignedUserId: null, assignedTeamId: null },
      supervisors: [SUPERVISOR],
      activeUsers: [SUPERVISOR],
    });

    await held.executor.execute(supervisorsAction, context({ actionIndex: 0 }));
    await held.executor.execute(
      { type: 'notify', audience: 'user', userId: SUPERVISOR, teamId: null, message: 'and this' },
      context({ actionIndex: 1 }),
    );

    // The two keys differ, so `UNIQUE (tenant_id, recipient_user_id, dedupe_key)`
    // admits both rows rather than swallowing the second.
    expect(
      held.notifications.map(({ recipientUserId, dedupeKey }) => ({ recipientUserId, dedupeKey })),
    ).toEqual([
      { recipientUserId: SUPERVISOR, dedupeKey: `${RUN}:0` },
      { recipientUserId: SUPERVISOR, dedupeKey: `${RUN}:1` },
    ]);
  });

  it('re-derives the same key on a redelivery, so a retry inserts nothing new', async () => {
    const held = harness({
      ticket: { assignedUserId: null, assignedTeamId: null },
      supervisors: [SUPERVISOR],
    });

    await held.executor.execute(supervisorsAction, context({ actionIndex: 2 }));
    await held.executor.execute(supervisorsAction, context({ actionIndex: 2 }));

    expect(held.notifications.map((row) => row.dedupeKey)).toEqual([`${RUN}:2`, `${RUN}:2`]);
  });
});
