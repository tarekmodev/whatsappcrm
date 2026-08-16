import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CannedResponseListResponse, TenantRole } from '@whatsappcrm/contracts';

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
