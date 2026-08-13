import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectedWhatsAppBusinessAccountResponseSchema,
  whatsAppSignupFailureReason,
  type ApiError,
  type ConnectedWhatsAppBusinessAccountResponse,
  type CursorPage,
  type MessageResponse,
  type MessageTemplateResponse,
  type TeamResponse,
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

    expect(page.items.map((item) => item.priority)).toEqual(['urgent', 'high', 'normal']);
  });

  it('re-sorts when a ticket is raised to urgent', async () => {
    // TAR-25 AC3 end to end: the console never re-sorts, so the queue coming
    // back in the new order is the whole of it. The raised ticket moves above
    // the `high` one and settles behind the urgent ticket opened after it —
    // `createdAt DESC` is the tie-break within a band, not an afterthought.
    asRole('supervisor');

    expect((await listTickets('?scope=all&limit=100')).items.map((item) => item.id)).toEqual([
      MOCK_IDS.tickets.fatimaUrgent,
      MOCK_IDS.tickets.meiUnassigned,
      MOCK_IDS.tickets.jonasPending,
    ]);

    await patchTicket(MOCK_IDS.tickets.jonasPending, { priority: 'urgent' });

    expect((await listTickets('?scope=all&limit=100')).items.map((item) => item.id)).toEqual([
      MOCK_IDS.tickets.fatimaUrgent,
      MOCK_IDS.tickets.jonasPending,
      MOCK_IDS.tickets.meiUnassigned,
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
    expect((await listTickets('?scope=unassigned&limit=100')).items.map((item) => item.id)).toEqual(
      [MOCK_IDS.tickets.meiUnassigned],
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
});
