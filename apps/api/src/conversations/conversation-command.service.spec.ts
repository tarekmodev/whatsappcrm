import type { EventEmitter2 } from '@nestjs/event-emitter';
import { permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { CONVERSATION_ASSIGNED_EVENT } from '../events/domain-events';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { isUnclaimed } from '../rbac/visibility';
import type { ConversationRow } from './conversation.mapper';
import { ConversationCommandService } from './conversation-command.service';
import type { ConversationQueryService } from './conversation-query.service';
import {
  ConversationAlreadyClaimedError,
  ConversationUnclaimedError,
} from './conversations.errors';

/**
 * Two things the conversation writer owns, because only it sees both sides of an
 * update.
 *
 * **What a hand-over announces, and when it says nothing (TAR-198).** The
 * relay's own spec proves where a hand-over goes; this proves that the event
 * carries the assignment the thread **had** — the one thing a subscriber cannot
 * recover after the write, and the only way the colleagues watching an unclaimed
 * thread are in the fan-out at all — and that a write which moved no column
 * emits nothing.
 *
 * **That a claim is a compare-and-set (TAR-186).** The shared pool shows the same
 * arriving conversation to every agent, so the claim has to be decided by the
 * database rather than by which read happened first. These cases fix the three
 * answers: the winner gets the thread, the loser gets a conflict, and the holder
 * re-claiming gets their own thread back rather than being told they lost it.
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
    botState: 'off' as const,
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

  // Both reads the writer makes, and `requireHeld` keeps its real rule rather
  // than resolving whatever it is handed: a status change into a thread nobody
  // holds must fail here for the same reason it fails in production.
  const conversations = {
    require: (): Promise<ConversationRow> => Promise.resolve(before),
    requireHeld: (): Promise<ConversationRow> =>
      isUnclaimed(before)
        ? Promise.reject(new ConversationUnclaimedError(CONVERSATION))
        : Promise.resolve(before),
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

  it('refuses a status change on a thread nobody holds', async () => {
    // Two agents resolving the same arriving conversation out from under each
    // other is the shared-pool conflict a duplicate reply is. Claim first.
    const { asTenant } = harnessFor(row(), row());

    await expect(
      asTenant(async (commands) => commands.setStatus(CONVERSATION, 'closed')),
    ).rejects.toBeInstanceOf(ConversationUnclaimedError);
  });
});

/**
 * The claim, with the update's row count as the only thing that decides it —
 * which is exactly what a real `UPDATE … WHERE assigned_user_id IS NULL` gives
 * back, and what makes two concurrent claims resolve to one winner.
 */
function claimHarness(options: {
  /** The row `require` loads before the write. */
  readonly before: ConversationRow;
  /** What the compare-and-set matched: 1 for the winner, 0 for everyone else. */
  readonly updated: number;
  /** The row as it stands after the write, for the read-back or the conflict report. */
  readonly current: ConversationRow | null;
}): Harness & { readonly updates: unknown[] } {
  const emitted: Emission[] = [];
  const updates: unknown[] = [];
  const tenantContext = new TenantContextService();

  const prisma = {
    conversation: {
      updateMany: (args: unknown): Promise<{ count: number }> => {
        updates.push(args);

        return Promise.resolve({ count: options.updated });
      },
      findUnique: (): Promise<ConversationRow | null> => Promise.resolve(options.current),
      findUniqueOrThrow: (): Promise<ConversationRow> => {
        if (options.current === null) {
          throw new Error('no row');
        }

        return Promise.resolve(options.current);
      },
    },
  } as unknown as TenantPrisma;

  const conversations = {
    require: (): Promise<ConversationRow> => Promise.resolve(options.before),
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
    updates,
    // A principal, not just a user id: the claim writes the *session's* own
    // assignee, and reading it from anywhere else is how a claim becomes a
    // re-assignment.
    asTenant: async (work) =>
      await tenantContext.run(
        { requestId: 'spec', tenantId: TENANT, userId: AGENT, principal: claimant() },
        async () => await work(commands),
      ),
  };
}

function claimant(): SessionPrincipal {
  return {
    userId: AGENT,
    tenantId: TENANT,
    email: 'agent@example.invalid',
    displayName: 'Ada Agent',
    role: 'agent',
    permissions: [...permissionsForRole('agent')],
    teamIds: [],
    sessionId: '68444444-4444-7444-8444-4444444444f1',
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

describe('claiming a conversation', () => {
  it('assigns the caller and announces the hand-over', async () => {
    const { asTenant, emitted } = claimHarness({
      before: row(),
      updated: 1,
      current: row({ assignedUserId: AGENT }),
    });

    const claimed = await asTenant(async (commands) => commands.claim(CONVERSATION));

    expect(claimed.assignedUserId).toBe(AGENT);
    expect(emitted[0]?.payload).toMatchObject({
      conversationId: CONVERSATION,
      previousAssignedUserId: null,
      previousAssignedTeamId: null,
    });
  });

  it('writes the claimable predicate into the update, so the database picks the winner', async () => {
    // The load-bearing assertion of the whole story: without `assignedUserId`
    // in the `WHERE`, a second claim overwrites the first and two agents believe
    // they hold the same thread.
    const { asTenant, updates } = claimHarness({
      before: row(),
      updated: 1,
      current: row({ assignedUserId: AGENT }),
    });

    await asTenant(async (commands) => commands.claim(CONVERSATION));

    expect(updates).toEqual([
      {
        where: { id: CONVERSATION, assignedUserId: null },
        data: { assignedUserId: AGENT, botState: 'human_active' },
      },
    ]);
  });

  it('stops the bot in the same compare-and-set, so only the winner writes it', async () => {
    // TAR-28, 0010 decision 5: taking a thread out of the shared pool is a
    // person taking it. Written in the claim's own statement rather than after
    // it, because a second statement could be applied by the agent who lost.
    const { asTenant, updates } = claimHarness({
      before: row(),
      updated: 1,
      current: row({ assignedUserId: AGENT }),
    });

    await asTenant(async (commands) => commands.claim(CONVERSATION));

    expect(updates[0]).toMatchObject({ data: { botState: 'human_active' } });
  });

  it('reports a conflict to the agent who lost the race, and announces nothing', async () => {
    const { asTenant, emitted } = claimHarness({
      before: row(),
      updated: 0,
      current: row({ assignedUserId: OTHER_AGENT }),
    });

    await expect(asTenant(async (commands) => commands.claim(CONVERSATION))).rejects.toBeInstanceOf(
      ConversationAlreadyClaimedError,
    );
    expect(emitted).toEqual([]);
  });

  it('answers a re-claim by the holder with their own thread, not a conflict', async () => {
    // A double-clicked button, or a retry after a dropped response. Telling an
    // agent who does hold the thread that somebody else took it would be a lie.
    const { asTenant, emitted } = claimHarness({
      before: row({ assignedUserId: AGENT }),
      updated: 0,
      current: row({ assignedUserId: AGENT }),
    });

    const claimed = await asTenant(async (commands) => commands.claim(CONVERSATION));

    expect(claimed.assignedUserId).toBe(AGENT);
    expect(emitted).toEqual([]);
  });

  it('takes a team-routed thread without taking it off the team', async () => {
    // A conversation routed to Billing and picked up by one of its members is
    // still Billing's: the claim writes the assignee and never touches the team.
    // Only a member sees it in the first place, which is the other half of
    // "bounded to the caller's teams' unassigned records".
    const { asTenant, updates } = claimHarness({
      before: row({ assignedTeamId: TEAM }),
      updated: 1,
      current: row({ assignedUserId: AGENT, assignedTeamId: TEAM }),
    });

    const claimed = await asTenant(async (commands) => commands.claim(CONVERSATION));

    expect(claimed).toMatchObject({ assignedUserId: AGENT, assignedTeamId: TEAM });
    expect(updates).toEqual([
      {
        where: { id: CONVERSATION, assignedUserId: null },
        data: { assignedUserId: AGENT, botState: 'human_active' },
      },
    ]);
  });
});
