import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectedWhatsAppBusinessAccountResponseSchema,
  whatsAppSignupFailureReason,
  type ApiError,
  type ConnectedWhatsAppBusinessAccountResponse,
  type CursorPage,
  type TeamResponse,
  type TenantRole,
  type UserResponse,
} from '@whatsappcrm/contracts';

/**
 * The mock transport is the only place a tenant-scoping or permission decision can
 * be exercised end to end before TAR-81 lands, so it is worth testing directly.
 *
 * `server-only` throws outside a React Server Component, and `next/headers` needs a
 * request scope — both are stubbed so these stay plain unit tests.
 */

vi.mock('server-only', () => ({}));

let currentRole: TenantRole = 'admin';

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === 'wac_role_stub' ? { name, value: currentRole } : undefined),
    }),
}));

const { handleMockRequest, MOCK_EXPIRED_SIGNUP_CODE } = await import('./handlers');
const { resetMockState } = await import('./store');
const { OTHER_TENANT_ID, MOCK_IDS, MOCK_TENANT_ID } = await import('./fixtures');
const { ApiRequestError } = await import('@/lib/api/http');

function asRole(role: TenantRole): void {
  currentRole = role;
}

beforeEach(() => {
  resetMockState();
  asRole('admin');
});

describe('tenant scoping', () => {
  it('never returns another tenant’s users', async () => {
    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/users?limit=100',
    })) as CursorPage<UserResponse>;

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((user) => user.id)).not.toContain(MOCK_IDS.users.otherTenant);
  });

  it('never returns another tenant’s teams', async () => {
    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/teams?limit=100',
    })) as CursorPage<TeamResponse>;

    expect(page.items.map((team) => team.id)).not.toContain(MOCK_IDS.teams.otherTenant);
  });

  it('never returns another tenant’s conversations, even at the widest scope', async () => {
    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/conversations?scope=all&limit=100',
    })) as CursorPage<{ id: string }>;

    expect(page.items.map((conversation) => conversation.id)).not.toContain(
      MOCK_IDS.conversations.otherTenant,
    );
  });

  it('answers 404, not 403, for another tenant’s record so nothing can be enumerated', async () => {
    const attempt = handleMockRequest({
      method: 'PATCH',
      path: `/v1/users/${MOCK_IDS.users.otherTenant}`,
      body: { role: 'agent' },
    });

    await expect(attempt).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('refuses to put another tenant’s user into one of this tenant’s teams', async () => {
    const attempt = handleMockRequest({
      method: 'PATCH',
      path: `/v1/teams/${MOCK_IDS.teams.billing}`,
      body: { memberUserIds: [MOCK_IDS.users.otherTenant] },
    });

    await expect(attempt).rejects.toBeInstanceOf(ApiRequestError);
    await expect(attempt).rejects.toMatchObject({ status: 404 });
  });

  it('strips the internal tenant column from every response', async () => {
    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/users?limit=100',
    })) as CursorPage<UserResponse>;

    for (const user of page.items) {
      expect(user).not.toHaveProperty('tenantId');
    }

    // Sanity check that the fixtures really do hold two tenants, so the
    // assertions above are not passing vacuously.
    expect(OTHER_TENANT_ID).not.toBe(MOCK_TENANT_ID);
  });
});

describe('role enforcement', () => {
  it('refuses an agent the people-management writes', async () => {
    asRole('agent');

    await expect(
      handleMockRequest({
        method: 'POST',
        path: '/v1/users/invites',
        body: { email: 'new@northwind.example', role: 'agent', teamIds: [] },
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });

    await expect(
      handleMockRequest({ method: 'POST', path: '/v1/teams', body: { name: 'Nope' } }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('lets a supervisor invite, edit and create teams, but not remove a user', async () => {
    asRole('supervisor');

    await expect(
      handleMockRequest({
        method: 'POST',
        path: '/v1/users/invites',
        body: { email: 'new@northwind.example', role: 'agent', teamIds: [] },
      }),
    ).resolves.toMatchObject({ status: 'invited' });

    // TAR-79 granted `user:update`: a supervisor may suspend someone or change
    // their teams from the person's side.
    await expect(
      handleMockRequest({
        method: 'PATCH',
        path: `/v1/users/${MOCK_IDS.users.amina}`,
        body: { status: 'suspended' },
      }),
    ).resolves.toMatchObject({ status: 'suspended' });

    // Deletion stays admin-only.
    await expect(
      handleMockRequest({ method: 'DELETE', path: `/v1/users/${MOCK_IDS.users.amina}` }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

/**
 * TAR-79's three role-assignment invariants. These are the escalation paths, so
 * they are asserted against the transport rather than trusted to the dialog that
 * hides the control.
 */
describe('role assignment', () => {
  it('refuses a supervisor a role change, even though they may edit the person', async () => {
    asRole('supervisor');

    await expect(
      handleMockRequest({
        method: 'PATCH',
        path: `/v1/users/${MOCK_IDS.users.amina}`,
        body: { role: 'supervisor' },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a supervisor an invite above agent, so they cannot mint an admin', async () => {
    asRole('supervisor');

    await expect(
      handleMockRequest({
        method: 'POST',
        path: '/v1/users/invites',
        body: { email: 'escalation@northwind.example', role: 'admin', teamIds: [] },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses an admin a change to their own role, so nobody can self-demote', async () => {
    asRole('admin');

    await expect(
      handleMockRequest({
        method: 'PATCH',
        path: `/v1/users/${MOCK_IDS.users.omar}`,
        body: { role: 'agent' },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets an admin change someone else’s role', async () => {
    asRole('admin');

    await expect(
      handleMockRequest({
        method: 'PATCH',
        path: `/v1/users/${MOCK_IDS.users.amina}`,
        body: { role: 'supervisor' },
      }),
    ).resolves.toMatchObject({ role: 'supervisor' });
  });
});

describe('removal is a soft delete', () => {
  it('keeps the row as `removed` rather than dropping it', async () => {
    await handleMockRequest({ method: 'DELETE', path: `/v1/users/${MOCK_IDS.users.amina}` });

    // Absent from the default list, so the account is gone from every screen…
    const listed = (await handleMockRequest({
      method: 'GET',
      path: '/v1/users?limit=100',
    })) as CursorPage<UserResponse>;

    expect(listed.items.map((user) => user.id)).not.toContain(MOCK_IDS.users.amina);

    // …but still there when asked for by name, so the record survives.
    const removed = (await handleMockRequest({
      method: 'GET',
      path: '/v1/users?limit=100&status=removed',
    })) as CursorPage<UserResponse>;

    expect(removed.items.map((user) => user.id)).toContain(MOCK_IDS.users.amina);
    expect(removed.items[0]?.occupiesSeat).toBe(false);
  });
});

describe('conversation scoping', () => {
  it('narrows an agent’s `all` to their work plus whatever nobody has claimed', async () => {
    asRole('agent');

    // Asks for everything; the agent lacks `conversation:read_all`, so the
    // contract has the API narrow it rather than refuse.
    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/conversations?scope=all&limit=100',
    })) as CursorPage<{ id: string }>;

    const ids = page.items.map((conversation) => conversation.id);

    expect(ids).toContain(MOCK_IDS.conversations.assignedToAmina);
    // Assigned to her Billing team, so visible — TAR-22's second criterion.
    expect(ids).toContain(MOCK_IDS.conversations.billingTeam);
    // ADR 0002 amendment 4: a thread nobody has claimed is visible to every
    // agent, because a customer wrote in and it is otherwise visible to nobody.
    expect(ids).toContain(MOCK_IDS.conversations.unassigned);
    // Another agent's, in a team she is not in — still invisible.
    expect(ids).not.toContain(MOCK_IDS.conversations.assignedToLiang);
  });

  it('lets an agent browse the unclaimed pool', async () => {
    asRole('agent');

    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/conversations?scope=unassigned&limit=100',
    })) as CursorPage<{ id: string }>;

    expect(page.items.map((conversation) => conversation.id)).toEqual([
      MOCK_IDS.conversations.unassigned,
    ]);
  });

  it('lets a supervisor see every conversation in their tenant', async () => {
    asRole('supervisor');

    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/conversations?scope=all&limit=100',
    })) as CursorPage<{ id: string }>;

    const ids = page.items.map((conversation) => conversation.id);

    expect(ids).toContain(MOCK_IDS.conversations.assignedToLiang);
    expect(ids).toContain(MOCK_IDS.conversations.unassigned);
  });
});

/**
 * The thread, its notes and the claim (TAR-71). These are the routes the shared
 * inbox reads and writes, and the visibility rule they share is the one place a
 * mistake would show one agent another's conversation.
 */
describe('one conversation', () => {
  const AMINA_THREAD = `/v1/conversations/${MOCK_IDS.conversations.assignedToAmina}`;

  it('serves the thread newest-first, with its attachments', async () => {
    asRole('agent');

    const page = (await handleMockRequest({
      method: 'GET',
      path: `${AMINA_THREAD}/messages?limit=100`,
    })) as CursorPage<{ id: string; sentAt: string; attachments: unknown[] }>;

    expect(page.items.length).toBeGreaterThan(1);
    expect(page.items[0]?.sentAt.localeCompare(page.items[1]?.sentAt ?? '')).toBeGreaterThan(0);
    expect(page.items.some((message) => message.attachments.length > 0)).toBe(true);
  });

  it('answers `not_found` for a thread the caller may not see, never `forbidden`', async () => {
    asRole('agent');

    await expect(
      handleMockRequest({
        method: 'GET',
        path: `/v1/conversations/${MOCK_IDS.conversations.assignedToLiang}`,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('lets an agent read a conversation nobody has claimed', async () => {
    asRole('agent');

    await expect(
      handleMockRequest({
        method: 'GET',
        path: `/v1/conversations/${MOCK_IDS.conversations.unassigned}`,
      }),
    ).resolves.toMatchObject({ assignedUserId: null, assignedTeamId: null });
  });

  it('refuses an agent the claim, which needs conversation:assign', async () => {
    asRole('agent');

    await expect(
      handleMockRequest({
        method: 'POST',
        path: `/v1/conversations/${MOCK_IDS.conversations.unassigned}/assign`,
        body: { userId: MOCK_IDS.users.amina },
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('lets a supervisor claim an unassigned conversation and release it again', async () => {
    asRole('supervisor');

    const path = `/v1/conversations/${MOCK_IDS.conversations.unassigned}/assign`;

    await expect(
      handleMockRequest({ method: 'POST', path, body: { userId: MOCK_IDS.users.priya } }),
    ).resolves.toMatchObject({ assignedUserId: MOCK_IDS.users.priya });

    // Releasing clears both columns, which is what puts it back in
    // `scope=unassigned` where every agent can see it again.
    await expect(
      handleMockRequest({ method: 'POST', path, body: { userId: null, teamId: null } }),
    ).resolves.toMatchObject({ assignedUserId: null, assignedTeamId: null });
  });

  it('refuses an assignee who is not an active member of the tenant', async () => {
    asRole('supervisor');

    await expect(
      handleMockRequest({
        method: 'POST',
        path: `/v1/conversations/${MOCK_IDS.conversations.unassigned}/assign`,
        body: { userId: MOCK_IDS.users.otherTenant },
      }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      handleMockRequest({
        method: 'POST',
        path: `/v1/conversations/${MOCK_IDS.conversations.unassigned}/assign`,
        // Invited but never accepted: no session, so nothing would reach them.
        body: { userId: MOCK_IDS.users.noor },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('writes a note as the caller, whatever the body claims', async () => {
    asRole('agent');

    const note = (await handleMockRequest({
      method: 'POST',
      path: `${AMINA_THREAD}/notes`,
      body: { body: 'Chased accounting.', authorUserId: MOCK_IDS.users.omar },
    })) as { authorUserId: string; body: string };

    expect(note.authorUserId).toBe(MOCK_IDS.users.amina);

    const page = (await handleMockRequest({
      method: 'GET',
      path: `${AMINA_THREAD}/notes?limit=100`,
    })) as CursorPage<{ body: string }>;

    expect(page.items.map((item) => item.body)).toContain('Chased accounting.');
  });

  it('refuses a mention that names nobody in this tenant', async () => {
    asRole('agent');

    await expect(
      handleMockRequest({
        method: 'POST',
        path: `${AMINA_THREAD}/notes`,
        body: { body: 'Over to you.', mentionedUserIds: [MOCK_IDS.users.otherTenant] },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects an empty note before it reaches the store', async () => {
    asRole('agent');

    await expect(
      handleMockRequest({ method: 'POST', path: `${AMINA_THREAD}/notes`, body: { body: '' } }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('membership stays consistent across both sides of the relation', () => {
  it('adding an agent to a team updates the agent’s teamIds too', async () => {
    await handleMockRequest({
      method: 'PATCH',
      path: `/v1/teams/${MOCK_IDS.teams.onboarding}`,
      body: { memberUserIds: [MOCK_IDS.users.amina] },
    });

    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/users?limit=100',
    })) as CursorPage<UserResponse>;
    const amina = page.items.find((user) => user.id === MOCK_IDS.users.amina);

    expect(amina?.teamIds).toContain(MOCK_IDS.teams.onboarding);
  });

  it('changing an agent’s teams updates each team’s member list too', async () => {
    await handleMockRequest({
      method: 'PATCH',
      path: `/v1/users/${MOCK_IDS.users.amina}`,
      body: { teamIds: [MOCK_IDS.teams.onboarding] },
    });

    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/teams?limit=100',
    })) as CursorPage<TeamResponse>;

    expect(
      page.items.find((team) => team.id === MOCK_IDS.teams.onboarding)?.memberUserIds,
    ).toContain(MOCK_IDS.users.amina);
    expect(
      page.items.find((team) => team.id === MOCK_IDS.teams.billing)?.memberUserIds,
    ).not.toContain(MOCK_IDS.users.amina);
  });

  it('removing an agent unassigns their conversations rather than deleting them', async () => {
    await handleMockRequest({ method: 'DELETE', path: `/v1/users/${MOCK_IDS.users.amina}` });

    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/conversations?scope=all&limit=100',
    })) as CursorPage<{ id: string; assignedUserId: string | null }>;
    const conversation = page.items.find(
      (candidate) => candidate.id === MOCK_IDS.conversations.assignedToAmina,
    );

    expect(conversation).toBeDefined();
    expect(conversation?.assignedUserId).toBeNull();
  });
});

describe('validation', () => {
  it('rejects an invite with a malformed email', async () => {
    await expect(
      handleMockRequest({
        method: 'POST',
        path: '/v1/users/invites',
        body: { email: 'not-an-email', role: 'agent', teamIds: [] },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('rejects a duplicate email inside the tenant', async () => {
    await expect(
      handleMockRequest({
        method: 'POST',
        path: '/v1/users/invites',
        body: { email: 'amina@northwind.example', role: 'agent', teamIds: [] },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

/**
 * The WhatsApp connection (TAR-169). The endpoint exists here so the console's
 * connected view can be reached in mock mode at all — without it every run in
 * that mode ends in `not_found`, which reads as a bug in the flow rather than as
 * a gap in the fixtures.
 */
describe('connecting a WhatsApp Business Account', () => {
  const CONNECT_PATH = '/v1/whatsapp/business-accounts';
  const WABA_ID = '102290129340398';

  it('answers with the connected account and its numbers', async () => {
    const connected = (await handleMockRequest({
      method: 'POST',
      path: CONNECT_PATH,
      body: { code: 'a-fresh-code', wabaId: WABA_ID },
    })) as ConnectedWhatsAppBusinessAccountResponse;

    expect(connected.wabaId).toBe(WABA_ID);
    expect(connected.accounts).toHaveLength(1);
    expect(connected.accounts[0]?.whatsappBusinessAccountId).toBe(connected.id);
    // The whole response has to satisfy the contract, or the console's own parse
    // would reject what this hands it.
    expect(() => ConnectedWhatsAppBusinessAccountResponseSchema.parse(connected)).not.toThrow();
  });

  /**
   * Carries an envelope, unlike every other refusal in the transport: the console
   * branches on `details.reason`, and a `whatsapp_signup_failed` without one
   * exercises the fallback instead of the taxonomy.
   */
  it('refuses the sentinel code with a reason the console can branch on', async () => {
    const error = await handleMockRequest({
      method: 'POST',
      path: CONNECT_PATH,
      body: { code: MOCK_EXPIRED_SIGNUP_CODE, wabaId: WABA_ID },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as InstanceType<typeof ApiRequestError>).code).toBe('whatsapp_signup_failed');
    expect(whatsAppSignupFailureReason((error as { envelope: ApiError }).envelope)).toBe(
      'code_expired',
    );
  });

  it('refuses a caller whose role does not include channel:manage', async () => {
    asRole('supervisor');

    await expect(
      handleMockRequest({
        method: 'POST',
        path: CONNECT_PATH,
        body: { code: 'a-fresh-code', wabaId: WABA_ID },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects a body the contract does not accept', async () => {
    await expect(
      handleMockRequest({
        method: 'POST',
        path: CONNECT_PATH,
        body: { code: 'a-fresh-code', wabaId: 'not-a-meta-id' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
