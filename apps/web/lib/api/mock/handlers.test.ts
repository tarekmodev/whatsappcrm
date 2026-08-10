import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CursorPage, TeamResponse, TenantRole, UserResponse } from '@whatsappcrm/contracts';

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

const { handleMockRequest } = await import('./handlers');
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

  it('lets a supervisor invite and create teams but not edit or remove a user', async () => {
    asRole('supervisor');

    await expect(
      handleMockRequest({
        method: 'POST',
        path: '/v1/users/invites',
        body: { email: 'new@northwind.example', role: 'agent', teamIds: [] },
      }),
    ).resolves.toMatchObject({ status: 'invited' });

    await expect(
      handleMockRequest({
        method: 'PATCH',
        path: `/v1/users/${MOCK_IDS.users.amina}`,
        body: { role: 'supervisor' },
      }),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      handleMockRequest({ method: 'DELETE', path: `/v1/users/${MOCK_IDS.users.amina}` }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('conversation scoping', () => {
  it('narrows an agent’s scope to their own and their teams’ conversations', async () => {
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
    // Another agent's, in a team she is not in.
    expect(ids).not.toContain(MOCK_IDS.conversations.assignedToLiang);
    expect(ids).not.toContain(MOCK_IDS.conversations.unassigned);
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
