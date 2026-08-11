import type { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { CONVERSATION_ASSIGNED_EVENT } from '../events/domain-events';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { ConversationRow } from './conversation.mapper';
import { ConversationCommandService } from './conversation-command.service';
import type { ConversationQueryService } from './conversation-query.service';

/**
 * What the claim endpoint announces, and when it says nothing (TAR-198).
 *
 * The relay's own spec proves where a hand-over goes. This proves the two things
 * only the writer can get right, because only the writer sees both sides of the
 * update:
 *
 *   * the event carries the assignment the thread **had** — the one thing a
 *     subscriber cannot recover after the write, and the only way the colleagues
 *     watching an unclaimed thread are in the fan-out at all;
 *   * an assign that moved no column emits nothing, so a re-claim of a thread by
 *     the agent already holding it is not a broadcast of nothing.
 */

const TENANT = '68444444-4444-7444-8444-444444444401';
const CONVERSATION = '68444444-4444-7444-8444-4444444444c1';
const AGENT = '68444444-4444-7444-8444-4444444444d1';
const OTHER_AGENT = '68444444-4444-7444-8444-4444444444d2';
const TEAM = '68444444-4444-7444-8444-4444444444e1';

interface Emission {
  readonly event: string;
  readonly payload: unknown;
}

interface Harness {
  readonly emitted: Emission[];
  /** Runs `work` in a tenant scope, as every route below `PrincipalGuard` does. */
  readonly asTenant: <T>(work: (commands: ConversationCommandService) => Promise<T>) => Promise<T>;
}

/** A conversation row in the shape `CONVERSATION_PROJECTION` selects. */
function row(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: CONVERSATION,
    whatsappAccountId: '68444444-4444-7444-8444-4444444444a0',
    status: 'open',
    assignedUserId: null,
    assignedTeamId: null,
    unreadCount: 0,
    serviceWindowExpiresAt: null,
    lastMessageAt: new Date('2026-08-11T09:00:00.000Z'),
    createdAt: new Date('2026-08-11T08:00:00.000Z'),
    updatedAt: new Date('2026-08-11T09:00:00.000Z'),
    contact: {
      id: '68444444-4444-7444-8444-4444444444b1',
      phoneE164: '+966500000001',
      displayName: 'Maria',
      email: null,
      customFields: {},
      lastSeenAt: null,
      optedOutAt: null,
      createdAt: new Date('2026-08-11T08:00:00.000Z'),
      updatedAt: new Date('2026-08-11T08:00:00.000Z'),
      tags: [],
    },
    messages: [],
    tickets: [],
    ...overrides,
  };
}

/**
 * The service with its two reads stubbed: the row `require` loads before the
 * write, and the row the write reads back. Both are `CONVERSATION_PROJECTION`
 * shapes, because that is what both really answer.
 */
function harnessFor(before: ConversationRow, after: ConversationRow): Harness {
  const emitted: Emission[] = [];
  const tenantContext = new TenantContextService();

  const prisma = {
    conversation: { update: (): Promise<ConversationRow> => Promise.resolve(after) },
    // Every assignee named by these tests is a live member of the tenant.
    user: { findUnique: (): Promise<{ id: string }> => Promise.resolve({ id: AGENT }) },
    team: { findUnique: (): Promise<{ id: string }> => Promise.resolve({ id: TEAM }) },
  } as unknown as TenantPrisma;

  const conversations = {
    require: (): Promise<ConversationRow> => Promise.resolve(before),
  } as unknown as ConversationQueryService;

  const events = {
    emit: (event: string, payload: unknown): boolean => {
      emitted.push({ event, payload });
      return true;
    },
  } as unknown as EventEmitter2;

  const commands = new ConversationCommandService(prisma, conversations, tenantContext, events);

  return {
    emitted,
    // The tenant on the event comes from the scope rather than from anything the
    // request carries, which is the property worth exercising rather than
    // stubbing: an unscoped call is a thrown error, not a silent `null` tenant.
    asTenant: async (work) =>
      await tenantContext.run(
        { requestId: 'spec', tenantId: TENANT, userId: AGENT },
        async () => await work(commands),
      ),
  };
}

describe('announcing a conversation hand-over', () => {
  it('carries the assignment the thread had, not the one it has', async () => {
    const { asTenant, emitted } = harnessFor(
      row({ assignedUserId: AGENT }),
      row({ assignedUserId: OTHER_AGENT }),
    );

    await asTenant(async (commands) => commands.assign(CONVERSATION, { userId: OTHER_AGENT }));

    expect(emitted).toEqual([
      {
        event: CONVERSATION_ASSIGNED_EVENT,
        payload: {
          tenantId: TENANT,
          conversationId: CONVERSATION,
          previousAssignedUserId: AGENT,
          previousAssignedTeamId: null,
        },
      },
    ]);
  });

  it('announces a claim of a thread nobody held', async () => {
    const { asTenant, emitted } = harnessFor(row(), row({ assignedUserId: AGENT }));

    await asTenant(async (commands) => commands.assign(CONVERSATION, { userId: AGENT }));

    expect(emitted[0]?.payload).toMatchObject({
      previousAssignedUserId: null,
      previousAssignedTeamId: null,
    });
  });

  it('announces a release back into the shared pool', async () => {
    const { asTenant, emitted } = harnessFor(row({ assignedUserId: AGENT }), row());

    await asTenant(async (commands) => commands.assign(CONVERSATION, { userId: null }));

    expect(emitted[0]?.payload).toMatchObject({ previousAssignedUserId: AGENT });
  });

  it('announces a move from an agent to a team', async () => {
    const { asTenant, emitted } = harnessFor(
      row({ assignedUserId: AGENT }),
      row({ assignedUserId: null, assignedTeamId: TEAM }),
    );

    await asTenant(async (commands) =>
      commands.assign(CONVERSATION, { userId: null, teamId: TEAM }),
    );

    expect(emitted[0]?.payload).toMatchObject({
      previousAssignedUserId: AGENT,
      previousAssignedTeamId: null,
    });
  });

  it('says nothing when the assign moved no column', async () => {
    // Re-claiming a thread you already hold. The comparison is against the row,
    // not the input: the input's three cases — absent, null, an id — do not say
    // by themselves whether anything changed.
    const { asTenant, emitted } = harnessFor(
      row({ assignedUserId: AGENT }),
      row({ assignedUserId: AGENT }),
    );

    await asTenant(async (commands) => commands.assign(CONVERSATION, { userId: AGENT }));

    expect(emitted).toEqual([]);
  });

  it('says nothing for a status change, which moves no audience', async () => {
    const { asTenant, emitted } = harnessFor(row({ assignedUserId: AGENT }), row());

    await asTenant(async (commands) => commands.setStatus(CONVERSATION, 'closed'));

    expect(emitted).toEqual([]);
  });
});
