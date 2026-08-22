import { permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { ConversationRow } from './conversation.mapper';
import { ConversationQueryService } from './conversation-query.service';
import { ConversationNotFoundError, ConversationUnclaimedError } from './conversations.errors';

/**
 * The two gates every single-conversation route goes through, and the line
 * between them (TAR-186).
 *
 * `require` answers a **read**: an unclaimed conversation is visible to every
 * agent on the tenant, because a customer wrote in and until somebody claims it
 * there is by construction nobody it is visible to.
 *
 * `requireHeld` answers a **write**, and adds the one thing that widening cost:
 * if all of them can see it, all of them can reply to it, and the customer gets
 * two answers from two agents who each believed they were the one handling it.
 * So the shared pool is a queue rather than a workspace — claim, then write.
 *
 * Proved here rather than only end to end because it is the check the send, the
 * note and the status change each delegate to, and a regression in it is a
 * duplicate reply to a real customer.
 */

const TENANT = '68444444-4444-7444-8444-444444444401';
const CONVERSATION = '68444444-4444-7444-8444-4444444444c1';
const AGENT = '68444444-4444-7444-8444-4444444444d1';
const OTHER_AGENT = '68444444-4444-7444-8444-4444444444d2';
const TEAM = '68444444-4444-7444-8444-4444444444e1';

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

function agentPrincipal(overrides: Partial<SessionPrincipal> = {}): SessionPrincipal {
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
    ...overrides,
  };
}

/** The service over one stubbed row, run inside a principal's scope. */
function asPrincipal<T>(
  found: ConversationRow | null,
  principal: SessionPrincipal,
  work: (conversations: ConversationQueryService) => Promise<T>,
): Promise<T> {
  const tenantContext = new TenantContextService();
  const prisma = {
    conversation: { findUnique: (): Promise<ConversationRow | null> => Promise.resolve(found) },
  } as unknown as TenantPrisma;

  return tenantContext.run(
    { requestId: 'spec', tenantId: TENANT, userId: principal.userId, principal },
    async () => await work(new ConversationQueryService(prisma, tenantContext)),
  );
}

describe('reading one conversation', () => {
  it('opens an unclaimed thread for any agent — the shared inbox', async () => {
    await expect(
      asPrincipal(row(), agentPrincipal(), async (conversations) =>
        conversations.require(CONVERSATION),
      ),
    ).resolves.toMatchObject({ id: CONVERSATION });
  });

  it('answers not_found for a thread a colleague holds', async () => {
    await expect(
      asPrincipal(row({ assignedUserId: OTHER_AGENT }), agentPrincipal(), async (conversations) =>
        conversations.require(CONVERSATION),
      ),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});

describe('writing into one conversation', () => {
  it('refuses a thread nobody holds, whoever is asking', async () => {
    // The duplicate reply this closes: two agents both see this row in
    // `scope=unassigned`, and without this both of them send.
    await expect(
      asPrincipal(row(), agentPrincipal(), async (conversations) =>
        conversations.requireHeld(CONVERSATION),
      ),
    ).rejects.toBeInstanceOf(ConversationUnclaimedError);
  });

  it('refuses a supervisor too, rather than exempting the role', async () => {
    // A supervisor replying into the pool produces the same two answers. They
    // hold `conversation:assign` and can take the thread in the same click, so
    // the uniform rule costs them nothing and buys no `if (role === …)`.
    await expect(
      asPrincipal(
        row(),
        agentPrincipal({ role: 'supervisor', permissions: [...permissionsForRole('supervisor')] }),
        async (conversations) => conversations.requireHeld(CONVERSATION),
      ),
    ).rejects.toBeInstanceOf(ConversationUnclaimedError);
  });

  it('allows the agent holding it', async () => {
    await expect(
      asPrincipal(row({ assignedUserId: AGENT }), agentPrincipal(), async (conversations) =>
        conversations.requireHeld(CONVERSATION),
      ),
    ).resolves.toMatchObject({ assignedUserId: AGENT });
  });

  it('allows a member of the team it is routed to', async () => {
    // Routing to a team is a deliberate act by a supervisor or a rule, so the
    // thread is held and its members may work it. Two members of the same team
    // can still both reply — that is the team queue's own coordination problem,
    // not the anonymous shared pool this rule is about.
    await expect(
      asPrincipal(
        row({ assignedTeamId: TEAM }),
        agentPrincipal({ teamIds: [TEAM] }),
        async (conversations) => conversations.requireHeld(CONVERSATION),
      ),
    ).resolves.toMatchObject({ assignedTeamId: TEAM });
  });

  it('answers not_found — not a claim prompt — for a thread the caller may not see', async () => {
    // Order matters: visibility first, so an id belonging to a colleague can
    // never be probed by reading which of the two refusals comes back.
    await expect(
      asPrincipal(row({ assignedUserId: OTHER_AGENT }), agentPrincipal(), async (conversations) =>
        conversations.requireHeld(CONVERSATION),
      ),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});
