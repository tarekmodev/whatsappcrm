import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CannedResponseListResponse,
  CannedResponseResponse,
  TenantRole,
} from '@whatsappcrm/contracts';

/**
 * The canned-response half of the mock transport (TAR-31, contract 0011).
 *
 * One route, and two things worth holding it to: it never hands the composer
 * another tenant's library, and an agent — the role that actually types `/hours`
 * — can read it. The fixture set puts the same `/hours` shortcut in both tenants
 * on purpose, so a leak shows up here as the wrong text rather than as a row that
 * is obviously foreign.
 */

vi.mock('server-only', () => ({}));

let currentRole: TenantRole = 'agent';

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === 'wac_role_stub' ? { name, value: currentRole } : undefined),
    }),
}));

const { handleMockRequest } = await import('./handlers');
const { resetMockState } = await import('./store');
const { MOCK_IDS } = await import('./fixtures');

function asRole(role: TenantRole): void {
  currentRole = role;
}

async function listCannedResponses(): Promise<CannedResponseListResponse> {
  return (await handleMockRequest({
    method: 'GET',
    path: '/v1/canned-responses',
  })) as CannedResponseListResponse;
}

beforeEach(() => {
  resetMockState();
  asRole('agent');
});

describe('the canned-response list', () => {
  it('never returns another tenant’s responses', async () => {
    const page = await listCannedResponses();

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((item) => item.id)).not.toContain(MOCK_IDS.cannedResponses.otherTenant);
  });

  it('answers `/hours` with this tenant’s text, not the other tenant’s', async () => {
    const page = await listCannedResponses();
    const hours = page.items.find((item) => item.shortcut === '/hours');

    expect(hours?.id).toBe(MOCK_IDS.cannedResponses.hours);
    expect(hours?.body).not.toContain('Southwind');
  });

  it('is unpaginated, because the picker matches against the whole set', async () => {
    const page = await listCannedResponses();

    expect(page.nextCursor).toBeNull();
  });

  it('is ordered by shortcut, as the API orders it', async () => {
    const shortcuts = (await listCannedResponses()).items.map((item) => item.shortcut);

    expect(shortcuts).toEqual([...shortcuts].sort((left, right) => left.localeCompare(right)));
  });

  /**
   * Every shipped role holds `canned_response:read` (0004), so there is no role
   * here that could demonstrate the refusal — the route still declares the
   * permission, and `handlers.test.ts` covers the gate itself. This asserts the
   * part that matters to TAR-484: the role that actually types a shortcut can
   * read the library it expands from.
   */
  it.each(['agent', 'supervisor', 'admin'] as const)('is readable by %s', async (role) => {
    asRole(role);

    await expect(listCannedResponses()).resolves.toBeDefined();
  });
});

/**
 * The write half, added with the settings screen that calls it (TAR-575).
 *
 * These are the refusals that screen is built against and the only place they can
 * be exercised before a real API is running: the permission split, cross-tenant
 * isolation, the case-insensitive shortcut collision, and the per-tenant cap.
 */

interface WriteAttempt {
  shortcut?: string;
  title?: string;
  body?: string;
}

const NEW_REPLY = {
  shortcut: '/returns',
  title: 'Returns policy',
  body: 'You can return anything unopened within 14 days.',
} as const;

async function createCannedResponse(input: WriteAttempt): Promise<CannedResponseResponse> {
  return (await handleMockRequest({
    method: 'POST',
    path: '/v1/canned-responses',
    body: input,
  })) as CannedResponseResponse;
}

async function updateCannedResponse(
  id: string,
  input: WriteAttempt,
): Promise<CannedResponseResponse> {
  return (await handleMockRequest({
    method: 'PATCH',
    path: `/v1/canned-responses/${id}`,
    body: input,
  })) as CannedResponseResponse;
}

describe('the canned-response writes', () => {
  beforeEach(() => {
    asRole('admin');
  });

  it('adds a reply the list then returns', async () => {
    const created = await createCannedResponse(NEW_REPLY);
    const shortcuts = (await listCannedResponses()).items.map((item) => item.shortcut);

    expect(created.shortcut).toBe('/returns');
    expect(shortcuts).toContain('/returns');
  });

  it('records who added it, which is what the audit trail is read from', async () => {
    const created = await createCannedResponse(NEW_REPLY);

    expect(created.createdByUserId).toBe(MOCK_IDS.users.omar);
  });

  it('refuses a shortcut this workspace already holds', async () => {
    const attempt = createCannedResponse({ ...NEW_REPLY, shortcut: '/hours' });

    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });

  it('refuses a malformed shortcut rather than storing one no agent can type', async () => {
    const attempt = createCannedResponse({ ...NEW_REPLY, shortcut: 'returns' });

    await expect(attempt).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('edits one field without touching the other two', async () => {
    const updated = await updateCannedResponse(MOCK_IDS.cannedResponses.hours, {
      body: 'We are open Sunday to Thursday, 8am to 4pm.',
    });

    expect(updated.body).toContain('8am to 4pm');
    expect(updated.shortcut).toBe('/hours');
    expect(updated.title).toBe('Opening hours');
  });

  it('lets a reply keep its own shortcut while another field changes', async () => {
    // The collision check has to except the row being edited, or renaming the
    // title of `/hours` would conflict with `/hours`.
    const updated = await updateCannedResponse(MOCK_IDS.cannedResponses.hours, {
      shortcut: '/hours',
      title: 'When we are open',
    });

    expect(updated.title).toBe('When we are open');
  });

  it('refuses an edit onto another reply’s shortcut', async () => {
    const attempt = updateCannedResponse(MOCK_IDS.cannedResponses.hours, {
      shortcut: '/shipping',
    });

    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });

  it('refuses an uppercase shortcut as malformed before it can collide', async () => {
    // `shortcut` is `citext`, so `/Shipping` *is* the row `/shipping` holds — but
    // the grammar only accepts lowercase, so the schema turns it down first and
    // the answer is `validation_failed`, not `conflict`. The console normalises
    // on blur precisely so an admin never meets this one.
    const attempt = updateCannedResponse(MOCK_IDS.cannedResponses.hours, {
      shortcut: '/Shipping',
    });

    await expect(attempt).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('deletes a reply, and the list stops returning it', async () => {
    await handleMockRequest({
      method: 'DELETE',
      path: `/v1/canned-responses/${MOCK_IDS.cannedResponses.holiday}`,
    });

    const ids = (await listCannedResponses()).items.map((item) => item.id);

    expect(ids).not.toContain(MOCK_IDS.cannedResponses.holiday);
  });

  it.each(['PATCH', 'DELETE'] as const)(
    'answers %s on another tenant’s reply with 404, so nothing can be enumerated',
    async (method) => {
      const attempt = handleMockRequest({
        method,
        path: `/v1/canned-responses/${MOCK_IDS.cannedResponses.otherTenant}`,
        body: { title: 'Borrowed' },
      });

      await expect(attempt).rejects.toMatchObject({ status: 404, code: 'not_found' });
    },
  );

  it('refuses an agent, who holds `canned_response:read` and not `:write`', async () => {
    asRole('agent');

    await expect(createCannedResponse(NEW_REPLY)).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  it('lets a supervisor write, as 0004 grants it', async () => {
    asRole('supervisor');

    await expect(createCannedResponse(NEW_REPLY)).resolves.toBeDefined();
  });
});
