import { permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { ConversationAccessService } from './conversation-access.service';

/**
 * Who may join `conversation:{id}` (TAR-69).
 *
 * The tenant half of the answer is row-level security and is proved against a
 * real database in `realtime-isolation.int-spec.ts`; here the client stands in
 * for it by returning `null` for a row RLS would not have shown, which is what
 * the extension actually does. What this file pins is the half that lives in
 * application code: the TAR-22 visibility predicate, applied to a subscribe the
 * same way the conversation list applies it to a read.
 */

const TENANT_A = '80111111-1111-7111-8111-111111111101';
const USER_A = '80111111-1111-7111-8111-1111111111a1';
const USER_B = '80111111-1111-7111-8111-1111111111a2';
const TEAM_SUPPORT = '80111111-1111-7111-8111-1111111111b1';
const TEAM_BILLING = '80111111-1111-7111-8111-1111111111b2';
const CONVERSATION = '80111111-1111-7111-8111-1111111111c1';
const SESSION_A = '80111111-1111-7111-8111-1111111111f1';

interface ConversationRow {
  id: string;
  assignedUserId: string | null;
  assignedTeamId: string | null;
}

function principal(overrides: Partial<SessionPrincipal> = {}): SessionPrincipal {
  const role = overrides.role ?? 'agent';

  return {
    userId: USER_A,
    tenantId: TENANT_A,
    email: 'ada@acme.invalid',
    displayName: 'Ada Agent',
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [],
    sessionId: SESSION_A,
    expiresAt: '2036-12-31T23:59:59.000Z',
    ...overrides,
  };
}

/**
 * `null` is what `TenantPrisma` answers for a conversation in another tenant —
 * RLS filters it, so it is indistinguishable from one that does not exist.
 */
function accessFor(row: ConversationRow | null): {
  access: ConversationAccessService;
  queries: unknown[];
} {
  const queries: unknown[] = [];

  const prisma = {
    conversation: {
      findUnique: (args: unknown): Promise<ConversationRow | null> => {
        queries.push(args);
        return Promise.resolve(row);
      },
    },
  } as unknown as TenantPrisma;

  return { access: new ConversationAccessService(prisma), queries };
}

describe('authorising conversation.subscribe', () => {
  it('refuses a conversation the tenant scope does not show', async () => {
    // Another tenant's id, or one that never existed. The gateway compares no
    // tenant ids of its own — this is RLS answering, and the refusal is the same
    // either way so the channel cannot be used to probe for live ids.
    const { access } = accessFor(null);

    await expect(access.maySubscribe(principal(), CONVERSATION)).resolves.toBe(false);
  });

  it('asks for the two columns the rule reads and nothing else', async () => {
    const { access, queries } = accessFor({
      id: CONVERSATION,
      assignedUserId: USER_A,
      assignedTeamId: null,
    });

    await access.maySubscribe(principal(), CONVERSATION);

    expect(queries).toEqual([
      {
        where: { id: CONVERSATION },
        select: { id: true, assignedUserId: true, assignedTeamId: true },
      },
    ]);
  });

  it('admits a supervisor to any conversation in their tenant', async () => {
    const { access } = accessFor({
      id: CONVERSATION,
      assignedUserId: USER_B,
      assignedTeamId: TEAM_BILLING,
    });

    await expect(
      access.maySubscribe(principal({ role: 'supervisor' }), CONVERSATION),
    ).resolves.toBe(true);
  });

  it('admits an agent to a conversation assigned to them', async () => {
    const { access } = accessFor({
      id: CONVERSATION,
      assignedUserId: USER_A,
      assignedTeamId: null,
    });

    await expect(access.maySubscribe(principal(), CONVERSATION)).resolves.toBe(true);
  });

  it('admits an agent to a conversation routed to a team they are in', async () => {
    const { access } = accessFor({
      id: CONVERSATION,
      assignedUserId: null,
      assignedTeamId: TEAM_SUPPORT,
    });

    await expect(
      access.maySubscribe(principal({ teamIds: [TEAM_SUPPORT] }), CONVERSATION),
    ).resolves.toBe(true);
  });

  it('refuses an agent another team’s conversation', async () => {
    const { access } = accessFor({
      id: CONVERSATION,
      assignedUserId: USER_B,
      assignedTeamId: TEAM_BILLING,
    });

    await expect(
      access.maySubscribe(principal({ teamIds: [TEAM_SUPPORT] }), CONVERSATION),
    ).resolves.toBe(false);
  });

  it('admits an agent to a conversation nobody has claimed', async () => {
    // Wider than `isVisible`, and deliberately so: TAR-68's amendment 4 rules
    // that an unclaimed thread is visible to every agent on the tenant, because
    // a customer wrote in and until somebody claims it there is nobody it would
    // otherwise be visible to. The socket must not be narrower than the route —
    // an agent who can open the thread over HTTP and gets no live updates for it
    // is the worst of both answers.
    const { access } = accessFor({
      id: CONVERSATION,
      assignedUserId: null,
      assignedTeamId: null,
    });

    await expect(access.maySubscribe(principal(), CONVERSATION)).resolves.toBe(true);
  });

  it('still refuses an agent a conversation somebody else has claimed', async () => {
    // The unclaimed widening stops here: claiming is what takes a thread out of
    // the shared pool.
    const { access } = accessFor({
      id: CONVERSATION,
      assignedUserId: USER_B,
      assignedTeamId: null,
    });

    await expect(access.maySubscribe(principal(), CONVERSATION)).resolves.toBe(false);
  });
});
