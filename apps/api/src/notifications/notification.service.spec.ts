import { permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { NotificationService } from './notification.service';
import { InvalidNotificationCursorError, NotificationNotFoundError } from './notifications.errors';

/**
 * The inbox's decisions, as behaviour rather than as SQL.
 *
 * RLS and the indexes are proved against a real database elsewhere; what this
 * file covers is what the *service* puts in the `where` clause, because every
 * omission there is silent:
 *
 *   * a read that forgets `recipient_user_id` returns a colleague's inbox and
 *     looks exactly like a working endpoint;
 *   * a read that forgets the type filter answers with an `escalation` row whose
 *     `type` the published enum does not contain;
 *   * an acknowledge that reads before it writes lets two tabs move a timestamp
 *     that answers "when did you first see this";
 *   * another principal's id must answer `not_found` and never `forbidden`,
 *     or the endpoint enumerates what colleagues were told about.
 */

const TENANT = '31000000-0000-7000-8000-0000000000a1';
const CALLER = '31000000-0000-7000-8000-0000000000a2';
const TICKET = '31000000-0000-7000-8000-0000000000a3';
const NOTIFICATION = '31000000-0000-7000-8000-0000000000a4';
const WORKFLOW = '31000000-0000-7000-8000-0000000000a5';
const RUN = '31000000-0000-7000-8000-0000000000a6';

interface FakeRow {
  id: string;
  type: string;
  ticketId: string;
  slaTimerId: string | null;
  dueAt: Date | null;
  data: unknown;
  acknowledgedAt: Date | null;
  createdAt: Date;
  ticket: { number: number };
}

interface Recorded {
  findManyArgs: { where?: unknown; take?: number; orderBy?: unknown }[];
  updateManyArgs: { where?: unknown; data?: unknown }[];
  findFirstArgs: { where?: unknown }[];
}

function workflowNotifyRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: NOTIFICATION,
    type: 'workflow_notify',
    ticketId: TICKET,
    slaTimerId: null,
    dueAt: null,
    data: { workflowId: WORKFLOW, workflowRunId: RUN, message: 'Take a look at this one.' },
    acknowledgedAt: null,
    createdAt: new Date('2026-08-22T09:00:00.000Z'),
    ticket: { number: 412 },
    ...overrides,
  };
}

function buildService(rows: readonly FakeRow[]): {
  notifications: NotificationService;
  tenantContext: TenantContextService;
  recorded: Recorded;
} {
  const recorded: Recorded = { findManyArgs: [], updateManyArgs: [], findFirstArgs: [] };
  const prisma = {
    notification: {
      findMany: (args: { take?: number }) => {
        recorded.findManyArgs.push(args);
        return Promise.resolve(rows.slice(0, args.take));
      },
      updateMany: (args: unknown) => {
        recorded.updateManyArgs.push(args as Recorded['updateManyArgs'][number]);
        return Promise.resolve({ count: 1 });
      },
      findFirst: (args: unknown) => {
        recorded.findFirstArgs.push(args as Recorded['findFirstArgs'][number]);
        return Promise.resolve(rows[0] ?? null);
      },
    },
  } as unknown as TenantPrisma;

  const tenantContext = new TenantContextService();

  return { notifications: new NotificationService(prisma, tenantContext), tenantContext, recorded };
}

function principal(): SessionPrincipal {
  return {
    userId: CALLER,
    tenantId: TENANT,
    email: 'supervisor@example.invalid',
    displayName: 'Supervisor',
    role: 'supervisor',
    permissions: [...permissionsForRole('supervisor')],
    teamIds: [],
    sessionId: '31000000-0000-7000-8000-0000000000ff',
    expiresAt: '2026-12-31T23:59:59.000Z',
  };
}

function asCaller<T>(tenantContext: TenantContextService, work: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { requestId: 'req_notifications_spec', tenantId: TENANT, userId: CALLER, principal: null },
    async () => {
      tenantContext.setPrincipal(principal());
      return work();
    },
  );
}

describe('NotificationService.list', () => {
  it('narrows to the caller and to the published types', async () => {
    const { notifications, tenantContext, recorded } = buildService([workflowNotifyRow()]);

    await asCaller(tenantContext, () =>
      notifications.list({ limit: 25, unacknowledgedOnly: true }),
    );

    expect(recorded.findManyArgs).toHaveLength(1);
    expect(recorded.findManyArgs[0]?.where).toMatchObject({
      recipientUserId: CALLER,
      type: { in: ['sla_breach', 'workflow_notify', 'workflow_broken'] },
      acknowledgedAt: null,
    });
  });

  it('takes one row more than the page, so the next cursor costs no count', async () => {
    const { notifications, tenantContext, recorded } = buildService([]);

    await asCaller(tenantContext, () =>
      notifications.list({ limit: 10, unacknowledgedOnly: false }),
    );

    expect(recorded.findManyArgs[0]?.take).toBe(11);
    // `unacknowledgedOnly: false` widens the list rather than filtering it.
    expect(recorded.findManyArgs[0]?.where).not.toHaveProperty('acknowledgedAt');
  });

  it('narrows to one type when the caller asks for one', async () => {
    const { notifications, tenantContext, recorded } = buildService([]);

    await asCaller(tenantContext, () =>
      notifications.list({ limit: 25, unacknowledgedOnly: true, type: 'workflow_broken' }),
    );

    expect(recorded.findManyArgs[0]?.where).toMatchObject({ type: 'workflow_broken' });
  });

  it('flattens the workflow payload out of `data`', async () => {
    const { notifications, tenantContext } = buildService([workflowNotifyRow()]);

    const page = await asCaller(tenantContext, () =>
      notifications.list({ limit: 25, unacknowledgedOnly: true }),
    );

    expect(page.items).toEqual([
      {
        id: NOTIFICATION,
        type: 'workflow_notify',
        ticketId: TICKET,
        ticketNumber: 412,
        slaTimerId: null,
        dueAt: null,
        message: 'Take a look at this one.',
        workflowId: WORKFLOW,
        workflowRunId: RUN,
        acknowledgedAt: null,
        createdAt: '2026-08-22T09:00:00.000Z',
      },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('refuses a cursor it cannot read rather than serving page one', async () => {
    const { notifications, tenantContext } = buildService([]);

    await expect(
      asCaller(tenantContext, () =>
        notifications.list({ limit: 25, unacknowledgedOnly: true, cursor: 'not-a-cursor' }),
      ),
    ).rejects.toBeInstanceOf(InvalidNotificationCursorError);
  });
});

describe('NotificationService.acknowledge', () => {
  it('stamps only an unacknowledged row of the caller, then reads it back', async () => {
    const { notifications, tenantContext, recorded } = buildService([
      workflowNotifyRow({ acknowledgedAt: new Date('2026-08-22T09:05:00.000Z') }),
    ]);

    const acknowledged = await asCaller(tenantContext, () =>
      notifications.acknowledge(NOTIFICATION),
    );

    expect(recorded.updateManyArgs[0]?.where).toMatchObject({
      id: NOTIFICATION,
      recipientUserId: CALLER,
      acknowledgedAt: null,
    });
    expect(recorded.findFirstArgs[0]?.where).toMatchObject({
      id: NOTIFICATION,
      recipientUserId: CALLER,
    });
    expect(acknowledged.acknowledgedAt).toBe('2026-08-22T09:05:00.000Z');
  });

  it('answers not_found — never forbidden — when the row is not the caller’s', async () => {
    const { notifications, tenantContext } = buildService([]);

    await expect(
      asCaller(tenantContext, () => notifications.acknowledge(NOTIFICATION)),
    ).rejects.toBeInstanceOf(NotificationNotFoundError);
  });
});
