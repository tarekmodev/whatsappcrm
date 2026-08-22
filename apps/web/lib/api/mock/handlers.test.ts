import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectedWhatsAppBusinessAccountResponseSchema,
  ONBOARDING_STEP_IDS,
  OnboardingChecklistResponseSchema,
  TenantLifecycleResponseSchema,
  TenantResponseSchema,
  whatsAppSignupFailureReason,
  type ApiError,
  type ConnectedWhatsAppBusinessAccountResponse,
  type CursorPage,
  type MessageResponse,
  type MessageTemplateResponse,
  type OnboardingChecklistResponse,
  type SlaAlertResponse,
  type SlaPolicyResponse,
  type TeamResponse,
  type TenantLifecycleResponse,
  type TenantResponse,
  type TenantRole,
  type TicketResponse,
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

    // Both unclaimed threads, newest first. The second is the one the chatbot
    // handed over (TAR-28): `HandoffService` re-requests routing only when
    // nobody placed the ticket, so "the bot gave up and it is nobody's yet" is
    // exactly a shared-pool thread — and an agent who could not see it would
    // have to wait for a supervisor to assign work the bot already refused.
    expect(page.items.map((conversation) => conversation.id)).toEqual([
      MOCK_IDS.conversations.handedOff,
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

  it('refuses an agent the re-assignment, which needs conversation:assign', async () => {
    asRole('agent');

    await expect(
      handleMockRequest({
        method: 'POST',
        path: `/v1/conversations/${MOCK_IDS.conversations.unassigned}/assign`,
        body: { userId: MOCK_IDS.users.amina },
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('lets an agent claim a conversation nobody holds', async () => {
    // TAR-186: reading the shared pool and being unable to take anything out of
    // it is not a shared inbox. `conversation:claim` is every role's.
    asRole('agent');

    await expect(
      handleMockRequest({
        method: 'POST',
        path: `/v1/conversations/${MOCK_IDS.conversations.unassigned}/claim`,
      }),
    ).resolves.toMatchObject({ assignedUserId: MOCK_IDS.users.amina });
  });

  /**
   * Losing a claim has two answers, and which one a caller sees is decided by
   * whether they can still see the thread at all — the same pair the API
   * produces (0002 amendment 6). Both are refusals, and neither is a write.
   */
  it('answers not_found to an agent whose colleague took the thread first', async () => {
    const path = `/v1/conversations/${MOCK_IDS.conversations.unassigned}`;

    asRole('supervisor');
    await handleMockRequest({
      method: 'POST',
      path: `${path}/assign`,
      body: { userId: MOCK_IDS.users.priya },
    });

    // The dominant real-world case: a stale list still shows the thread in the
    // shared pool, and by the time the agent clicks Claim it is somebody's and
    // therefore invisible to them — `not_found`, exactly as opening it would be.
    // Reporting the conflict here would mean answering from a read that bypassed
    // visibility, which is the id-enumeration the taxonomy exists to prevent.
    asRole('agent');
    await expect(
      handleMockRequest({ method: 'POST', path: `${path}/claim` }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('answers conflict to a claimer who can still see the thread somebody holds', async () => {
    // The compare-and-set, from the losing side. A supervisor holds
    // `conversation:read_all`, so the thread stays visible and the refusal is
    // the claim's own: it can never take a thread off the person on it.
    const path = `/v1/conversations/${MOCK_IDS.conversations.unassigned}`;

    asRole('supervisor');
    await handleMockRequest({
      method: 'POST',
      path: `${path}/assign`,
      body: { userId: MOCK_IDS.users.amina },
    });

    await expect(
      handleMockRequest({ method: 'POST', path: `${path}/claim` }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });

  it('lets assign take a thread off the colleague holding it — the take-over', async () => {
    // The other side of the case above, and the reason the two are separate
    // routes: the claim refuses a held thread and the hand-over must not, or
    // every take-over in the console fails with "somebody else claimed this".
    const path = `/v1/conversations/${MOCK_IDS.conversations.unassigned}/assign`;

    asRole('supervisor');
    await handleMockRequest({ method: 'POST', path, body: { userId: MOCK_IDS.users.amina } });

    await expect(
      handleMockRequest({ method: 'POST', path, body: { userId: MOCK_IDS.users.priya } }),
    ).resolves.toMatchObject({ assignedUserId: MOCK_IDS.users.priya });
  });

  it('answers a re-claim by the holder with their own thread', async () => {
    const path = `/v1/conversations/${MOCK_IDS.conversations.unassigned}/claim`;

    asRole('agent');
    await handleMockRequest({ method: 'POST', path });

    // A double-click, or a retry after a dropped response. Telling an agent who
    // does hold the thread that somebody else took it would be a lie.
    await expect(handleMockRequest({ method: 'POST', path })).resolves.toMatchObject({
      assignedUserId: MOCK_IDS.users.amina,
    });
  });

  it('refuses a send and a note into a thread nobody holds', async () => {
    // The duplicate reply TAR-186 closes, as the console would meet it: the
    // composer is shut client-side, and this is the refusal behind that.
    asRole('agent');

    await expect(
      handleMockRequest({
        method: 'POST',
        path: `/v1/conversations/${MOCK_IDS.conversations.unassigned}/messages`,
        headers: { 'idempotency-key': '0192f004-0000-7000-8000-0000000009f1' },
        body: { type: 'text', body: 'On it!' },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });

    await expect(
      handleMockRequest({
        method: 'POST',
        path: `/v1/conversations/${MOCK_IDS.conversations.unassigned}/notes`,
        body: { body: 'Taking this one.' },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
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

describe('sending (TAR-20g)', () => {
  const KEY = '0192f0aa-0000-7000-8000-0000000000a1';
  const OTHER_KEY = '0192f0aa-0000-7000-8000-0000000000a2';

  function send(
    conversationId: string,
    body: unknown,
    idempotencyKey: string | null = KEY,
  ): Promise<unknown> {
    return handleMockRequest({
      method: 'POST',
      path: `/v1/conversations/${conversationId}/messages`,
      body,
      headers: idempotencyKey === null ? {} : { 'Idempotency-Key': idempotencyKey },
    });
  }

  const TEXT = { type: 'text', body: 'On its way.' };

  it('queues an outbound message inside the service window', async () => {
    const message = (await send(MOCK_IDS.conversations.assignedToAmina, TEXT)) as MessageResponse;

    expect(message).toMatchObject({
      direction: 'outbound',
      type: 'text',
      // The row is committed and the provider call is queued behind it.
      status: 'queued',
      body: 'On its way.',
    });
  });

  it('replays the original message when the same key arrives with the same body', async () => {
    const first = (await send(MOCK_IDS.conversations.assignedToAmina, TEXT)) as MessageResponse;
    const second = (await send(MOCK_IDS.conversations.assignedToAmina, TEXT)) as MessageResponse;

    // The guarantee the Send button's double-click protection rests on.
    expect(second.id).toBe(first.id);

    const thread = (await handleMockRequest({
      method: 'GET',
      path: `/v1/conversations/${MOCK_IDS.conversations.assignedToAmina}/messages?limit=100`,
    })) as CursorPage<MessageResponse>;

    expect(thread.items.filter((item) => item.id === first.id)).toHaveLength(1);
  });

  it('refuses a key already spent on a different body', async () => {
    await send(MOCK_IDS.conversations.assignedToAmina, TEXT);

    await expect(
      send(MOCK_IDS.conversations.assignedToAmina, { type: 'text', body: 'Something else.' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('sends again under a new key, which is what an edited draft gets', async () => {
    const first = (await send(MOCK_IDS.conversations.assignedToAmina, TEXT)) as MessageResponse;
    const second = (await send(
      MOCK_IDS.conversations.assignedToAmina,
      { type: 'text', body: 'Something else.' },
      OTHER_KEY,
    )) as MessageResponse;

    expect(second.id).not.toBe(first.id);
  });

  it.each([
    ['missing', null],
    ['not a UUID', 'not-a-uuid'],
  ])('refuses a send whose Idempotency-Key is %s', async (_case, key) => {
    await expect(send(MOCK_IDS.conversations.assignedToAmina, TEXT, key)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('refuses a free-form send outside the 24-hour window', async () => {
    // `assignedToLiang` has no window at all, which means the same thing as one
    // that has expired.
    await expect(send(MOCK_IDS.conversations.assignedToLiang, TEXT)).rejects.toMatchObject({
      code: 'whatsapp_window_expired',
    });
  });

  it('lets a template through the closed window, with its variables substituted', async () => {
    const message = (await send(MOCK_IDS.conversations.assignedToLiang, {
      type: 'template',
      templateName: 'appointment_reminder',
      languageCode: 'en_US',
      variables: ['Mei', 'Thursday'],
    })) as MessageResponse;

    expect(message.type).toBe('template');
    expect(message.body).toBe('Hello Mei, this is a reminder of your appointment on Thursday.');
  });

  it('refuses a template supplied the wrong number of values', async () => {
    await expect(
      send(MOCK_IDS.conversations.assignedToLiang, {
        type: 'template',
        templateName: 'appointment_reminder',
        languageCode: 'en_US',
        variables: ['Mei'],
      }),
    ).rejects.toMatchObject({ code: 'whatsapp_template_invalid' });
  });

  it('refuses a template whose approved header was not supplied', async () => {
    await expect(
      send(MOCK_IDS.conversations.assignedToLiang, {
        type: 'template',
        templateName: 'invoice_ready',
        languageCode: 'en_US',
        variables: ['INV-9'],
      }),
    ).rejects.toMatchObject({ code: 'whatsapp_template_invalid' });
  });

  it('attributes the message to the principal, never to a body field', async () => {
    // An agent holds `conversation:send`, so this is the ordinary path. The
    // sender is the session's own principal: a client that could name the
    // speaker would make the whole record worthless.
    asRole('agent');

    const message = (await send(MOCK_IDS.conversations.assignedToAmina, {
      ...TEXT,
      sentByUserId: MOCK_IDS.users.priya,
    })) as MessageResponse;

    expect(message.sentByUserId).toBe(MOCK_IDS.users.amina);
    expect(message.sentByAutomation).toBe(false);
  });
});

describe('message templates (TAR-20a)', () => {
  function listTemplates(query = ''): Promise<CursorPage<MessageTemplateResponse>> {
    return handleMockRequest({
      method: 'GET',
      path: `/v1/message-templates?limit=100${query}`,
    }) as Promise<CursorPage<MessageTemplateResponse>>;
  }

  it('returns this tenant’s approved templates, ordered by name', async () => {
    const page = await listTemplates();

    expect(page.items.map((item) => item.name)).toEqual([
      'appointment_reminder',
      'invoice_ready',
      'order_update',
    ]);
  });

  it('never returns another tenant’s templates', async () => {
    const page = await listTemplates();

    expect(page.items.map((item) => item.id)).not.toContain(MOCK_IDS.templates.otherTenant);
  });

  it('matches `q` on the start of the name, not anywhere in it', async () => {
    expect((await listTemplates('&q=order')).items.map((item) => item.name)).toEqual([
      'order_update',
    ]);
    expect((await listTemplates('&q=update')).items).toEqual([]);
  });

  it('filters by the conversation’s own number', async () => {
    const page = await listTemplates(`&whatsappAccountId=${MOCK_IDS.whatsappAccount}`);

    expect(page.items).not.toHaveLength(0);
  });

  it('refuses a number it does not know, as the real endpoint does', async () => {
    await expect(
      listTemplates(`&whatsappAccountId=${MOCK_IDS.conversations.otherTenant}`),
    ).rejects.toMatchObject({ code: 'validation_failed' });
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
 * The workspace record and its lifecycle (TAR-409, ADR 0009). Three routes, and
 * the two things worth asserting against the transport rather than against the
 * page: that the seat count is derived from this store rather than stored, and
 * that a partial `PATCH` cannot clobber the branding the form never showed.
 */
describe('the workspace record and its lifecycle', () => {
  it('answers with the caller’s own workspace, never another tenant’s', async () => {
    const tenant = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tenant',
    })) as TenantResponse;

    expect(tenant.id).toBe(MOCK_TENANT_ID);
    expect(tenant.id).not.toBe(OTHER_TENANT_ID);
    expect(TenantResponseSchema.safeParse(tenant).success).toBe(true);
  });

  it('validates the lifecycle against the published contract', async () => {
    const lifecycle = await handleMockRequest({ method: 'GET', path: '/v1/tenant/lifecycle' });

    expect(TenantLifecycleResponseSchema.safeParse(lifecycle).success).toBe(true);
  });

  it('counts active seats and pending invitations separately', async () => {
    const lifecycle = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tenant/lifecycle',
    })) as TenantLifecycleResponse;

    // Four active fixture users occupy a seat; Noor is invited and does not.
    expect(lifecycle.usage.seatsUsed).toBe(4);
    expect(lifecycle.usage.seatsPending).toBe(1);
  });

  it('moves the seat count when an invitation is sent, because it is counted and not stored', async () => {
    await handleMockRequest({
      method: 'POST',
      path: '/v1/users/invites',
      body: { email: 'new@northwind.example', role: 'agent', teamIds: [] },
    });

    const lifecycle = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tenant/lifecycle',
    })) as TenantLifecycleResponse;

    expect(lifecycle.usage.seatsUsed).toBe(4);
    expect(lifecycle.usage.seatsPending).toBe(2);
  });

  it('refuses the lifecycle to a role without tenant:settings', async () => {
    asRole('supervisor');

    await expect(
      handleMockRequest({ method: 'GET', path: '/v1/tenant/lifecycle' }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });

    // The record itself stays readable: it is the workspace name every principal
    // already sees in the chrome around them.
    await expect(handleMockRequest({ method: 'GET', path: '/v1/tenant' })).resolves.toMatchObject({
      id: MOCK_TENANT_ID,
    });
  });

  it('refuses the profile write to a role without branding:write', async () => {
    asRole('supervisor');

    await expect(
      handleMockRequest({ method: 'PATCH', path: '/v1/tenant', body: { name: 'Renamed' } }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('applies a partial update without clobbering the branding it was not sent', async () => {
    const before = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tenant',
    })) as TenantResponse;

    const updated = (await handleMockRequest({
      method: 'PATCH',
      path: '/v1/tenant',
      body: { name: 'Northwind Support Co', branding: { supportEmail: null } },
    })) as TenantResponse;

    expect(updated.name).toBe('Northwind Support Co');
    expect(updated.branding.supportEmail).toBeNull();
    // The colours and the product name were never sent and must survive.
    expect(updated.branding.primaryColor).toBe(before.branding.primaryColor);
    expect(updated.branding.productName).toBe(before.branding.productName);
  });

  it('rejects a body the contract refuses', async () => {
    await expect(
      handleMockRequest({ method: 'PATCH', path: '/v1/tenant', body: { name: '' } }),
    ).rejects.toMatchObject({ status: 422, code: 'validation_failed' });
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

// --- Tickets (TAR-25, ADR 0006) --------------------------------------------

async function listTickets(query = ''): Promise<CursorPage<TicketResponse>> {
  return (await handleMockRequest({
    method: 'GET',
    path: `/v1/tickets${query}`,
  })) as CursorPage<TicketResponse>;
}

async function patchTicket(id: string, body: unknown): Promise<TicketResponse> {
  return (await handleMockRequest({
    method: 'PATCH',
    path: `/v1/tickets/${id}`,
    body,
  })) as TicketResponse;
}

describe('the ticket queue', () => {
  it('never returns another tenant’s tickets, even at the widest scope', async () => {
    const page = await listTickets('?scope=all&limit=100');

    expect(page.items.map((item) => item.id)).not.toContain(MOCK_IDS.tickets.otherTenant);
  });

  it('defaults to the active statuses, which is what makes resolving remove a row', async () => {
    asRole('supervisor');

    const page = await listTickets('?scope=all&limit=100');
    const ids = page.items.map((item) => item.id);

    expect(ids).toContain(MOCK_IDS.tickets.fatimaUrgent);
    expect(ids).not.toContain(MOCK_IDS.tickets.fatimaResolved);
    expect(ids).not.toContain(MOCK_IDS.tickets.meiClosed);
  });

  it('returns a terminal ticket only when it is asked for by name', async () => {
    asRole('supervisor');

    const page = await listTickets('?scope=all&status=resolved&limit=100');

    expect(page.items.map((item) => item.id)).toEqual([MOCK_IDS.tickets.fatimaResolved]);
  });

  it('sorts urgent first, then newest — the one order, with no sort parameter', async () => {
    asRole('supervisor');

    const page = await listTickets('?scope=all&limit=100');

    // Six, not three: TAR-23's deferred fixtures are `open` and unassigned, so
    // they are live work and belong in the active queue like any other.
    expect(page.items.map((item) => item.priority)).toEqual([
      'urgent',
      'high',
      'high',
      'normal',
      'normal',
      'normal',
    ]);
  });

  it('re-sorts when a ticket is raised to urgent', async () => {
    // TAR-25 AC3 end to end: the console never re-sorts, so the queue coming
    // back in the new order is the whole of it. The raised ticket moves above
    // the `high` one and settles behind the urgent ticket opened after it —
    // `createdAt DESC` is the tie-break within a band, not an afterthought.
    asRole('supervisor');

    // TAR-23's three deferred tickets are active work too, so they sit in the
    // same queue and in the same order — which is what makes the move below a
    // move *through* them rather than within a set of three.
    expect((await listTickets('?scope=all&limit=100')).items.map((item) => item.id)).toEqual([
      MOCK_IDS.tickets.fatimaUrgent,
      MOCK_IDS.tickets.deferredAtCapacity,
      MOCK_IDS.tickets.meiUnassigned,
      MOCK_IDS.tickets.deferredNoCandidatePool,
      MOCK_IDS.tickets.deferredNoneAvailable,
      MOCK_IDS.tickets.jonasPending,
    ]);

    await patchTicket(MOCK_IDS.tickets.jonasPending, { priority: 'urgent' });

    expect((await listTickets('?scope=all&limit=100')).items.map((item) => item.id)).toEqual([
      MOCK_IDS.tickets.fatimaUrgent,
      MOCK_IDS.tickets.jonasPending,
      MOCK_IDS.tickets.deferredAtCapacity,
      MOCK_IDS.tickets.meiUnassigned,
      MOCK_IDS.tickets.deferredNoCandidatePool,
      MOCK_IDS.tickets.deferredNoneAvailable,
    ]);
  });

  it('narrows an agent asking for `all` to their own and their teams’', async () => {
    asRole('agent');

    const page = await listTickets('?scope=all&limit=100');
    const ids = page.items.map((item) => item.id);

    // Narrowed rather than refused, so a supervisor's shared link still renders.
    expect(ids).toContain(MOCK_IDS.tickets.fatimaUrgent);
    expect(ids).not.toContain(MOCK_IDS.tickets.meiUnassigned);
  });

  it('gives `unassigned` to a supervisor and nothing to an agent', async () => {
    // Unlike an unclaimed conversation, an unassigned ticket is triaged work.
    asRole('supervisor');
    // `unassigned` is "no user **and** no team", which is every deferred ticket
    // there is: a rule that matched would have assigned its target and stopped,
    // so a ticket only reaches deferral with both columns still null (TAR-537).
    // In queue order, so the deferred three are interleaved with Mei's by
    // priority rather than appended.
    expect((await listTickets('?scope=unassigned&limit=100')).items.map((item) => item.id)).toEqual(
      [
        MOCK_IDS.tickets.deferredAtCapacity,
        MOCK_IDS.tickets.meiUnassigned,
        MOCK_IDS.tickets.deferredNoCandidatePool,
        MOCK_IDS.tickets.deferredNoneAvailable,
      ],
    );

    asRole('agent');
    expect(
      (await listTickets('?scope=unassigned&limit=100')).items.map((item) => item.id),
    ).not.toContain(MOCK_IDS.tickets.meiUnassigned);
  });
});

describe('reading one ticket', () => {
  it('answers 404, not 403, for one this principal may not see', async () => {
    asRole('agent');

    await expect(
      handleMockRequest({ method: 'GET', path: `/v1/tickets/${MOCK_IDS.tickets.meiUnassigned}` }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('answers 404 for another tenant’s ticket', async () => {
    await expect(
      handleMockRequest({ method: 'GET', path: `/v1/tickets/${MOCK_IDS.tickets.otherTenant}` }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('changing a ticket', () => {
  it('records a resolution time on the way into resolved', async () => {
    const updated = await patchTicket(MOCK_IDS.tickets.fatimaUrgent, { status: 'resolved' });

    expect(updated.status).toBe('resolved');
    expect(updated.resolvedAt).not.toBeNull();
    expect(updated.closedAt).toBeNull();
  });

  it('leaves resolvedAt null when a ticket is closed without being resolved', async () => {
    // The honest signal for "closed unworked"; back-filling it would manufacture
    // a resolution that never happened.
    const updated = await patchTicket(MOCK_IDS.tickets.fatimaUrgent, { status: 'closed' });

    expect(updated.closedAt).not.toBeNull();
    expect(updated.resolvedAt).toBeNull();
  });

  it('keeps the original resolution time when a resolved ticket is closed', async () => {
    asRole('supervisor');

    const before = (await listTickets('?scope=all&status=resolved&limit=100')).items[0];
    const updated = await patchTicket(MOCK_IDS.tickets.fatimaResolved, { status: 'closed' });

    expect(updated.resolvedAt).toBe(before?.resolvedAt);
    expect(updated.closedAt).not.toBeNull();
  });

  it('refuses re-activating a resolved ticket with a conflict naming its status', async () => {
    asRole('supervisor');

    await expect(
      patchTicket(MOCK_IDS.tickets.fatimaResolved, { status: 'open' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('treats setting the status it already has as a no-op, not a conflict', async () => {
    // A double-clicked button and a retry after a dropped response both arrive
    // this way; answering 409 would show a failure for a request that achieved
    // exactly what was asked.
    const before = await patchTicket(MOCK_IDS.tickets.fatimaUrgent, { status: 'pending' });
    const again = await patchTicket(MOCK_IDS.tickets.fatimaUrgent, { status: 'pending' });

    expect(again.status).toBe('pending');
    expect(again.updatedAt).toBe(before.updatedAt);
  });

  it('rejects an empty body rather than accepting it as a no-op', async () => {
    await expect(patchTicket(MOCK_IDS.tickets.fatimaUrgent, {})).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('answers 404 for a ticket this principal may not see, on the write too', async () => {
    asRole('agent');

    await expect(
      patchTicket(MOCK_IDS.tickets.meiUnassigned, { priority: 'low' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('unlinks the conversation when its active ticket is resolved', async () => {
    // What empties the inbox context panel's ticket section. A fixture layer
    // that kept the link would let a stale panel ship looking fine.
    await patchTicket(MOCK_IDS.tickets.fatimaUrgent, { status: 'resolved' });

    const conversation = (await handleMockRequest({
      method: 'GET',
      path: `/v1/conversations/${MOCK_IDS.conversations.assignedToAmina}`,
    })) as { ticketId: string | null };

    expect(conversation.ticketId).toBeNull();
  });

  it('narrows to breached tickets when asked, and only then (TAR-26)', async () => {
    const all = await listTickets('?scope=all&limit=100');
    const overdue = await listTickets('?scope=all&limit=100&breachedOnly=true');

    expect(overdue.items.map((item) => item.id)).toEqual([MOCK_IDS.tickets.fatimaUrgent]);
    expect(all.items.length).toBeGreaterThan(overdue.items.length);
  });

  it('accepts `breachedOnly` as the query string it actually arrives as', async () => {
    // A bare `z.boolean()` answers 400 for `?breachedOnly=true` — the request the
    // contract's own documentation shows. `z.stringbool()` is why it does not,
    // and this is the regression that would catch a revert.
    await expect(listTickets('?breachedOnly=true')).resolves.toBeDefined();
  });

  it('reads `breachedOnly=false` as the full queue, not as every ticket', async () => {
    // `z.coerce.boolean()` would make this `true`: it is `Boolean('false')`.
    const page = await listTickets('?scope=all&limit=100&breachedOnly=false');

    expect(page.items.length).toBeGreaterThan(1);
  });

  it('still scopes to the tenant when the overdue filter is on', async () => {
    const page = await listTickets('?scope=all&limit=100&breachedOnly=true');

    expect(page.items.map((item) => item.id)).not.toContain(MOCK_IDS.tickets.otherTenant);
  });
});

async function listSlaAlerts(query = ''): Promise<CursorPage<SlaAlertResponse>> {
  return (await handleMockRequest({
    method: 'GET',
    path: `/v1/sla-alerts${query}`,
  })) as CursorPage<SlaAlertResponse>;
}

async function acknowledgeSlaAlert(id: string): Promise<SlaAlertResponse> {
  return (await handleMockRequest({
    method: 'POST',
    path: `/v1/sla-alerts/${id}/acknowledge`,
  })) as SlaAlertResponse;
}

describe('supervisor SLA alerts (TAR-26)', () => {
  it('returns only the calling principal’s own alerts', async () => {
    // Priya and Omar each hold a row for the *same* breach — ADR 0006 decision 4
    // resolves every active supervisor and admin, not one of them — so a handler
    // that filtered on tenant alone would hand Priya Omar's copy.
    asRole('supervisor');

    const page = await listSlaAlerts();

    expect(page.items.map((alert) => alert.id)).toEqual([MOCK_IDS.slaAlerts.priyaFatimaUrgent]);
  });

  it('never returns another tenant’s alerts', async () => {
    asRole('admin');

    const page = await listSlaAlerts();

    expect(page.items.map((alert) => alert.id)).not.toContain(MOCK_IDS.slaAlerts.otherTenant);
  });

  it('answers an agent with an empty page rather than a refusal', async () => {
    // The endpoint is `ticket:read`, which every role holds: the narrowing is the
    // protection, not the permission. An agent is simply never a recipient.
    asRole('agent');

    await expect(listSlaAlerts()).resolves.toMatchObject({ items: [] });
  });

  it('never publishes who an alert was addressed to', async () => {
    asRole('supervisor');

    const [alert] = (await listSlaAlerts()).items;

    expect(alert).toBeDefined();
    expect(alert).not.toHaveProperty('recipientUserId');
    expect(alert).not.toHaveProperty('tenantId');
  });

  it('drops an acknowledged alert from the default view, and keeps it otherwise', async () => {
    asRole('supervisor');

    await acknowledgeSlaAlert(MOCK_IDS.slaAlerts.priyaFatimaUrgent);

    await expect(listSlaAlerts()).resolves.toMatchObject({ items: [] });
    await expect(listSlaAlerts('?unacknowledgedOnly=false')).resolves.toMatchObject({
      items: [{ id: MOCK_IDS.slaAlerts.priyaFatimaUrgent }],
    });
  });

  it('acknowledges idempotently, keeping the first timestamp', async () => {
    // The panel removes the row optimistically and retries on failure; a second
    // call answering `conflict` would turn a dropped response into a rollback the
    // supervisor cannot explain.
    asRole('supervisor');

    const first = await acknowledgeSlaAlert(MOCK_IDS.slaAlerts.priyaFatimaUrgent);
    const again = await acknowledgeSlaAlert(MOCK_IDS.slaAlerts.priyaFatimaUrgent);

    expect(first.acknowledgedAt).not.toBeNull();
    expect(again.acknowledgedAt).toBe(first.acknowledgedAt);
  });

  it('answers 404, not 403, for somebody else’s alert', async () => {
    // A 403 would confirm the id exists (0002's rule).
    asRole('supervisor');

    await expect(acknowledgeSlaAlert(MOCK_IDS.slaAlerts.omarFatimaUrgent)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

// --- The SLA policy resource (TAR-26; the console screen is TAR-390) --------

describe('SLA policies', () => {
  async function listSlaPolicies(): Promise<CursorPage<SlaPolicyResponse>> {
    return (await handleMockRequest({
      method: 'GET',
      path: '/v1/sla-policies?limit=100',
    })) as CursorPage<SlaPolicyResponse>;
  }

  async function patchPolicy(id: string, body: unknown): Promise<SlaPolicyResponse> {
    return (await handleMockRequest({
      method: 'PATCH',
      path: `/v1/sla-policies/${id}`,
      body,
    })) as SlaPolicyResponse;
  }

  it('leads with the catch-all every ticket falls back to', async () => {
    // Oldest first is the API's keyset order, and the settings screen reads the
    // catch-all off this list — an order that followed map insertion instead
    // would let a console bug through review.
    asRole('supervisor');

    const page = await listSlaPolicies();

    expect(page.items[0]?.id).toBe(MOCK_IDS.slaPolicies.catchAll);
    expect(page.items[0]?.priority).toBeNull();
  });

  it('never returns another tenant’s policy', async () => {
    asRole('admin');

    const page = await listSlaPolicies();

    expect(page.items.map((policy) => policy.id)).not.toContain(
      MOCK_IDS.slaPolicies.otherTenant,
    );
  });

  it('refuses an agent, who holds neither SLA permission', async () => {
    // Unlike the alert routes, where every role may ask and the narrowing is
    // per-recipient: a policy is the tenant's configuration, and `sla:read` is
    // supervisor-and-above.
    asRole('agent');

    await expect(listSlaPolicies()).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('saves a window and reports it back', async () => {
    asRole('supervisor');

    const updated = await patchPolicy(MOCK_IDS.slaPolicies.catchAll, {
      firstResponseMinutes: 30,
      resolutionMinutes: null,
      isActive: true,
    });

    expect(updated).toMatchObject({ firstResponseMinutes: 30, resolutionMinutes: null });

    // Read back through the list, so a handler that answered from its argument
    // rather than from the store would fail here.
    const reread = (await listSlaPolicies()).items.find(
      (policy) => policy.id === MOCK_IDS.slaPolicies.catchAll,
    );

    expect(reread?.firstResponseMinutes).toBe(30);
  });

  it('turns SLA off without deleting the row running timers point at', async () => {
    // There is no DELETE, deliberately: `isActive: false` is how a tenant stops
    // giving new tickets a deadline, and the row stays.
    asRole('supervisor');

    await expect(
      patchPolicy(MOCK_IDS.slaPolicies.catchAll, { isActive: false }),
    ).resolves.toMatchObject({ id: MOCK_IDS.slaPolicies.catchAll, isActive: false });
  });

  it('refuses a window past the contract’s thirty-day ceiling', async () => {
    asRole('supervisor');

    await expect(
      patchPolicy(MOCK_IDS.slaPolicies.catchAll, { firstResponseMinutes: 43_201 }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses an empty body rather than reporting a save that changed nothing', async () => {
    asRole('supervisor');

    await expect(patchPolicy(MOCK_IDS.slaPolicies.catchAll, {})).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('answers 404, not 403, for another tenant’s policy id', async () => {
    // A 403 would confirm the id names a real row somebody else owns.
    asRole('admin');

    await expect(
      patchPolicy(MOCK_IDS.slaPolicies.otherTenant, { firstResponseMinutes: 30 }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a supervisor’s attempt to set a field the write schema omits', async () => {
    // `priority` belongs with the per-priority UI that is out of scope, and
    // `businessHoursOnly` is modelled but not implemented. Neither may be set,
    // which is why the console publishes no control for either.
    asRole('supervisor');

    const updated = await patchPolicy(MOCK_IDS.slaPolicies.catchAll, {
      firstResponseMinutes: 30,
      priority: 'urgent',
      businessHoursOnly: true,
    });

    expect(updated.priority).toBeNull();
    expect(updated.businessHoursOnly).toBe(false);
  });
});

// --- The supervisor's flagged queue (TAR-23, ADR 0008) ----------------------

describe('flagged ticket queue', () => {
  /**
   * `scope=all`, not `scope=unassigned`.
   *
   * TAR-286 fixed `unassigned` as "no user **and** no team", which is right for
   * the agent queue — but a ticket routed to a team by rule and then deferred
   * still carries `assignedTeamId`, and that is exactly the `all_at_capacity`
   * case this view exists to show. `routingState=deferred` already identifies the
   * flagged set on its own; `scope` only decides how wide the read is, and the
   * section is gated on `ticket:read_all` either way.
   */
  const FLAGGED_PATH = '/v1/tickets?scope=all&routingState=deferred&limit=100';

  async function listFlagged(): Promise<CursorPage<TicketResponse>> {
    return (await handleMockRequest({
      method: 'GET',
      path: FLAGGED_PATH,
    })) as CursorPage<TicketResponse>;
  }

  it('returns only tickets routing could not place', async () => {
    const page = await listFlagged();

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((ticket) => ticket.routing.state === 'deferred')).toBe(true);
    expect(page.items.map((ticket) => ticket.id)).not.toContain(MOCK_IDS.tickets.fatimaUrgent);
  });

  it('never returns another tenant’s flagged ticket', async () => {
    const page = await listFlagged();

    expect(page.items.map((ticket) => ticket.id)).not.toContain(
      MOCK_IDS.tickets.otherTenantDeferred,
    );
  });

  /**
   * Oldest stuck first, which is the list's one second order.
   *
   * ADR 0008 decision 3 gives `routing_deferred_since` to the schema for exactly
   * this ordering, and TAR-365 implemented it after TAR-273 had shipped the
   * predicate on the queue's own `(priority, created_at, id)` — 0008's
   * amendment 3 records the decision. The transport follows the API, so mock mode
   * cannot teach an ordering the product does not have.
   *
   * Asserted as ids and not as a sorted-ness property: the fixtures' priorities
   * happen to descend in this order too, so a check on priority alone would pass
   * against either sort and prove nothing.
   */
  it('orders the flagged queue oldest-stuck first, not by priority', async () => {
    const page = await listFlagged();

    expect(page.items.map((ticket) => ticket.id)).toEqual([
      MOCK_IDS.tickets.deferredAtCapacity,
      MOCK_IDS.tickets.deferredNoneAvailable,
      MOCK_IDS.tickets.deferredNoCandidatePool,
    ]);
  });

  it('is a different order from the one the same tickets take in the queue', async () => {
    // Where the two orders disagree, written down rather than left implicit: in
    // the queue the newest-created of the two `normal` tickets comes first, in the
    // flagged queue the longest-waiting does. If a change ever collapses the two
    // orders into one, this fails instead of the ordering quietly reverting.
    const flagged = (await listFlagged()).items.map((ticket) => ticket.id);
    const queue = await listTickets('?scope=all&limit=100');
    const deferredInQueueOrder = queue.items
      .filter((ticket) => ticket.routing.state === 'deferred')
      .map((ticket) => ticket.id);

    expect(deferredInQueueOrder).not.toEqual(flagged);
    expect([...deferredInQueueOrder].sort()).toEqual([...flagged].sort());
  });

  it('carries a reason on every flagged ticket', async () => {
    const page = await listFlagged();

    expect(page.items.every((ticket) => ticket.routing.deferredReason !== null)).toBe(true);
  });

  /**
   * Narrowed, not refused. TAR-286 settled that a caller without `ticket:read_all`
   * gets their own and their teams' tickets whatever scope they asked for, so a
   * supervisor's shared link still renders for an agent with less in it. The
   * flagged section itself is gated on `ticket:read_all` in the page, which is
   * where "you may not see this queue" belongs.
   */
  it('narrows the flagged queue to nothing for an agent who holds none of it', async () => {
    asRole('agent');

    const page = (await handleMockRequest({
      method: 'GET',
      path: FLAGGED_PATH,
    })) as CursorPage<TicketResponse>;

    // Empty, not merely short of one: a deferred ticket carries neither a user
    // nor a team (TAR-537), so there is nothing on any of them for the
    // own-and-my-teams predicate to match.
    expect(page.items).toEqual([]);
  });

  it('takes an assigned ticket off the queue and marks routing manual', async () => {
    asRole('supervisor');

    const assigned = (await handleMockRequest({
      method: 'POST',
      path: `/v1/tickets/${MOCK_IDS.tickets.deferredAtCapacity}/assign`,
      // A reason, though nothing requires one: a deferred ticket is held by
      // nobody, so `ticketAssignRequiresReason` is false for it (TAR-537). Sent
      // anyway because the field is accepted either way, and a placement that
      // carries one is the case worth exercising end to end.
      body: { userId: MOCK_IDS.users.amina, reason: 'Amina has room and knows the account.' },
    })) as TicketResponse;

    expect(assigned.assignedUserId).toBe(MOCK_IDS.users.amina);
    // `manual` is what stops a later routing pass overruling the supervisor.
    expect(assigned.routing).toEqual({
      state: 'manual',
      deferredReason: null,
      deferredSince: null,
    });

    const page = await listFlagged();

    expect(page.items.map((ticket) => ticket.id)).not.toContain(
      MOCK_IDS.tickets.deferredAtCapacity,
    );
  });

  it('refuses an assignment to a user outside the tenant', async () => {
    await expect(
      handleMockRequest({
        method: 'POST',
        path: `/v1/tickets/${MOCK_IDS.tickets.deferredAtCapacity}/assign`,
        body: { userId: MOCK_IDS.users.otherTenant, reason: 'Cross-tenant assignment attempt.' },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses an assignment to an account that cannot take work', async () => {
    await expect(
      handleMockRequest({
        method: 'POST',
        path: `/v1/tickets/${MOCK_IDS.tickets.deferredAtCapacity}/assign`,
        // Invited, never accepted.
        body: { userId: MOCK_IDS.users.noor, reason: 'Trying Noor while Billing is full.' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('answers not_found for another tenant’s ticket rather than forbidden', async () => {
    await expect(
      handleMockRequest({
        method: 'POST',
        path: `/v1/tickets/${MOCK_IDS.tickets.otherTenantDeferred}/assign`,
        body: { userId: MOCK_IDS.users.amina },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  /**
   * `not_found`, not `forbidden`: a deferred ticket carries neither a user nor a
   * team (TAR-537), so it fails the visibility rule before the act is judged —
   * the same answer this mock gives for any ticket a principal may not see, and
   * the reason emptying this queue is a `ticket:read_all` surface.
   */
  it('hides the flagged queue’s tickets from a role that may not read them all', async () => {
    asRole('agent');

    await expect(
      handleMockRequest({
        method: 'POST',
        path: `/v1/tickets/${MOCK_IDS.tickets.deferredAtCapacity}/assign`,
        body: { userId: MOCK_IDS.users.amina },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  /**
   * The bound itself, on a ticket the agent *can* see: Jonas's is held by her
   * team, which ADR 0011 decision 2 is explicit is not hers to give away. Kept
   * beside the case above so the 403 half of the assign route stays covered now
   * that no flagged ticket reaches it.
   */
  it('refuses a placement by somebody who does not hold the ticket', async () => {
    asRole('agent');

    await expect(
      handleMockRequest({
        method: 'POST',
        path: `/v1/tickets/${MOCK_IDS.tickets.jonasPending}/assign`,
        body: { userId: MOCK_IDS.users.amina },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  /**
   * The predicate PR #94's review asked for. Narrowing by reason has to happen
   * here, in the query, because the console cannot tell a reason with no tickets
   * from a reason whose tickets sort past the page it was handed.
   */
  it('narrows by deferral reason in the query', async () => {
    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tickets?scope=all&routingState=deferred&deferredReason=none_available&limit=100',
    })) as CursorPage<TicketResponse>;

    expect(page.items.map((ticket) => ticket.id)).toEqual([MOCK_IDS.tickets.deferredNoneAvailable]);
  });

  it('answers an empty page for a reason nothing matches, without a cursor', async () => {
    // `no_candidate_pool` has exactly one fixture; assigning it leaves the reason
    // real but empty, which is the state the filtered empty copy describes.
    await handleMockRequest({
      method: 'POST',
      path: `/v1/tickets/${MOCK_IDS.tickets.deferredNoCandidatePool}/assign`,
      body: { userId: MOCK_IDS.users.amina },
    });

    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tickets?scope=all&routingState=deferred&deferredReason=no_candidate_pool&limit=100',
    })) as CursorPage<TicketResponse>;

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a reason the contract does not publish', async () => {
    await expect(
      handleMockRequest({
        method: 'GET',
        path: '/v1/tickets?scope=all&routingState=deferred&deferredReason=everything_is_fine',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  /**
   * A cursor is what lets the view tell "that is all of them" from "that is the
   * first page". Returning `null` unconditionally is what made a capped page
   * indistinguishable from a complete queue.
   */
  it('returns a cursor when more tickets match than fit on the page', async () => {
    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tickets?scope=all&routingState=deferred&limit=1',
    })) as CursorPage<TicketResponse>;

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });

  it('returns no cursor when the page holds every match', async () => {
    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tickets?scope=all&routingState=deferred&limit=100',
    })) as CursorPage<TicketResponse>;

    expect(page.nextCursor).toBeNull();
  });

  /**
   * `breachedOnly` is the contract's only boolean on a *query* schema, and every
   * query value arrives as a string. The client already serialises `true`; before
   * this it met a `z.boolean()` that could never match one.
   */
  it('accepts breachedOnly as the string the client actually sends', async () => {
    await expect(
      handleMockRequest({
        method: 'GET',
        path: '/v1/tickets?scope=all&routingState=deferred&breachedOnly=true',
      }),
    ).resolves.toMatchObject({ items: expect.any(Array) as unknown[] });
  });

  it('accepts breachedOnly=false too, rather than only the truthy spelling', async () => {
    await expect(
      handleMockRequest({
        method: 'GET',
        path: '/v1/tickets?scope=all&routingState=deferred&breachedOnly=false',
      }),
    ).resolves.toMatchObject({ items: expect.any(Array) as unknown[] });
  });
});

/**
 * TAR-407's checklist. The two rules worth pinning in the transport rather than
 * in the UI: completion is derived from what the tenant actually did, and the
 * write endpoint refuses the status a client is not allowed to assert.
 */
describe('the onboarding checklist', () => {
  it('starts a workspace with everything still to do', async () => {
    const checklist = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tenant/onboarding',
    })) as OnboardingChecklistResponse;

    expect(OnboardingChecklistResponseSchema.safeParse(checklist).success).toBe(true);
    expect(checklist.tenantId).toBe(MOCK_TENANT_ID);
    expect(checklist.steps.every((step) => step.status === 'pending')).toBe(true);
  });

  it('is refused for a role without tenant:settings', async () => {
    asRole('supervisor');

    await expect(
      handleMockRequest({ method: 'GET', path: '/v1/tenant/onboarding' }),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('marks “invite your agents” done because somebody was actually invited', async () => {
    await handleMockRequest({
      method: 'POST',
      path: '/v1/users/invites',
      body: { email: 'new.agent@northwind.example', role: 'agent', teamIds: [] },
    });

    const checklist = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tenant/onboarding',
    })) as OnboardingChecklistResponse;

    expect(checklist.steps.find((step) => step.id === 'invite_agents')?.status).toBe('completed');
  });

  it('marks “connect a number” done only when the connection succeeds', async () => {
    await expect(
      handleMockRequest({
        method: 'POST',
        path: '/v1/whatsapp/business-accounts',
        body: { code: MOCK_EXPIRED_SIGNUP_CODE, wabaId: '102290129340398' },
      }),
    ).rejects.toBeInstanceOf(ApiRequestError);

    const afterFailure = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tenant/onboarding',
    })) as OnboardingChecklistResponse;

    expect(afterFailure.steps.find((step) => step.id === 'connect_whatsapp')?.status).toBe(
      'pending',
    );

    await handleMockRequest({
      method: 'POST',
      path: '/v1/whatsapp/business-accounts',
      body: { code: 'a-good-code', wabaId: '102290129340398' },
    });

    const afterSuccess = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tenant/onboarding',
    })) as OnboardingChecklistResponse;

    expect(afterSuccess.steps.find((step) => step.id === 'connect_whatsapp')?.status).toBe(
      'completed',
    );
  });

  it('skips a step and puts it back, which is the whole of “return to it later”', async () => {
    const skipped = (await handleMockRequest({
      method: 'PATCH',
      path: '/v1/tenant/onboarding/steps/set_branding',
      body: { intent: 'skip' },
    })) as OnboardingChecklistResponse;

    expect(skipped.steps.find((step) => step.id === 'set_branding')?.status).toBe('skipped');

    const reopened = (await handleMockRequest({
      method: 'PATCH',
      path: '/v1/tenant/onboarding/steps/set_branding',
      body: { intent: 'reopen' },
    })) as OnboardingChecklistResponse;

    expect(reopened.steps.find((step) => step.id === 'set_branding')?.status).toBe('pending');
    expect(reopened.steps.find((step) => step.id === 'set_branding')?.skippedAt).toBeNull();
  });

  it('finishes the checklist once nothing is pending, and un-finishes it on reopen', async () => {
    for (const stepId of ONBOARDING_STEP_IDS) {
      await handleMockRequest({
        method: 'PATCH',
        path: `/v1/tenant/onboarding/steps/${stepId}`,
        body: { intent: 'skip' },
      });
    }

    const complete = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tenant/onboarding',
    })) as OnboardingChecklistResponse;

    expect(complete.completedAt).not.toBeNull();

    const reopened = (await handleMockRequest({
      method: 'PATCH',
      path: '/v1/tenant/onboarding/steps/set_branding',
      body: { intent: 'reopen' },
    })) as OnboardingChecklistResponse;

    // An admin who puts a step back has outstanding setup again; a `completedAt`
    // that survived would leave the console showing "all done" over a live list.
    expect(reopened.completedAt).toBeNull();
  });

  it('refuses to skip a step the tenant has already done', async () => {
    await handleMockRequest({
      method: 'POST',
      path: '/v1/users/invites',
      body: { email: 'another.agent@northwind.example', role: 'agent', teamIds: [] },
    });

    await expect(
      handleMockRequest({
        method: 'PATCH',
        path: '/v1/tenant/onboarding/steps/invite_agents',
        body: { intent: 'skip' },
      }),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('refuses a status write, because completion is the server’s to derive', async () => {
    await expect(
      handleMockRequest({
        method: 'PATCH',
        path: '/v1/tenant/onboarding/steps/set_branding',
        body: { status: 'completed' },
      }),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('keeps one tenant’s checklist out of another’s', async () => {
    await handleMockRequest({
      method: 'PATCH',
      path: '/v1/tenant/onboarding/steps/set_branding',
      body: { intent: 'skip' },
    });

    // Read straight out of the store: there is no request that can name another
    // tenant, which is the point — the key is the caller's own tenant id.
    const { mockState } = await import('./store');

    expect(
      mockState()
        .onboarding.get(OTHER_TENANT_ID)
        ?.steps.every((step) => step.status === 'pending'),
    ).toBe(true);
  });
});
