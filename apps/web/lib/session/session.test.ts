import { afterEach, describe, expect, it, vi } from 'vitest';
import { permissionsForRole } from '@whatsappcrm/contracts';
import { REQUEST_PATH_HEADER } from '@/lib/session/session-paths';

/**
 * The authoritative half of the route guard. What these cases pin down is the
 * distinction the guard exists to get right: "the API says nobody" is a sign-in,
 * and "the API did not answer" is an error — conflating the two would sign
 * everybody out every time the API restarted, with no way for them to tell why.
 */

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));

vi.mock('@/lib/api/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/http')>()),
  apiRequest,
}));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => ({ value: 'opaque-session-id' }) }),
  headers: () => Promise.resolve(new Headers({ [REQUEST_PATH_HEADER]: '/settings/people' })),
}));

/** Stands in for the `NEXT_REDIRECT` throw, so a test can assert the destination. */
class RedirectSignal extends Error {
  constructor(readonly target: string) {
    super(`redirect:${target}`);
  }
}

vi.mock('next/navigation', () => ({
  RedirectType: { replace: 'replace', push: 'push' },
  redirect: (target: string) => {
    throw new RedirectSignal(target);
  },
}));

const PRINCIPAL = {
  userId: '0192f0ff-0000-7000-8000-000000000001',
  tenantId: '0192f0ff-0000-7000-8000-0000000000aa',
  email: 'sam@acme.example.com',
  displayName: 'Sam Agent',
  role: 'supervisor',
  permissions: [...permissionsForRole('supervisor')],
  teamIds: [],
  sessionId: '0192f0ff-0000-7000-8000-0000000000ff',
  expiresAt: '2026-12-31T23:59:59.000Z',
};

/**
 * `getSession` is wrapped in React's `cache`, which memoises per render pass.
 * Re-importing the module per test gives each one its own, so a `null` from one
 * case cannot be served to the next.
 *
 * `refuse` comes back with it, bound to the **same** module graph, and that is
 * not a convenience: `isSessionExpiredError` narrows with `instanceof`, and
 * `vi.resetModules()` gives the reloaded guard a fresh `ApiRequestError` class.
 * An error built from a class captured before the reset is an instance of a
 * different constructor with the same name, and the guard would rethrow it as an
 * unrecognised failure instead of reading it as a lost session.
 */
async function loadSession(): Promise<
  typeof import('./session') & { refuse: (status: number, code: string) => Error }
> {
  vi.resetModules();

  const [session, { ApiRequestError }] = await Promise.all([
    import('./session'),
    import('@/lib/api/error'),
  ]);

  return {
    ...session,
    refuse: (status, code) => new ApiRequestError(status, code, 'Refused', null),
  };
}

afterEach(() => {
  apiRequest.mockReset();
});

describe('getSession', () => {
  it('resolves the principal the API reports, permissions and all', async () => {
    apiRequest.mockResolvedValue({ user: PRINCIPAL });

    const { getSession } = await loadSession();
    const session = await getSession();

    expect(session?.principal.role).toBe('supervisor');
    expect(session?.isStubbed).toBe(false);
    // Role gating reads from here, so it has to arrive from the session rather
    // than be re-derived in the browser.
    expect(session?.checker.can('conversation:read_all')).toBe(true);
    expect(session?.checker.can('user:set_role')).toBe(false);
  });

  it('forwards the browser session cookie, without which the call is anonymous', async () => {
    apiRequest.mockResolvedValue({ user: PRINCIPAL });

    const { getSession } = await loadSession();
    await getSession();

    expect(apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/auth/session',
        headers: { cookie: '__Host-wac_session=opaque-session-id' },
      }),
    );
  });

  it.each([
    ['no session, or one that expired or was revoked', 401, 'unauthenticated'],
    ['a session replayed against another tenant’s host', 401, 'tenant_mismatch'],
  ])('reports no session for %s', async (_case, status, code) => {
    const { getSession, refuse } = await loadSession();

    apiRequest.mockRejectedValue(refuse(status, code));

    await expect(getSession()).resolves.toBeNull();
  });

  it('rethrows an unreachable API rather than treating it as a sign-out', async () => {
    const { getSession, refuse } = await loadSession();

    apiRequest.mockRejectedValue(refuse(502, 'upstream_unavailable'));

    await expect(getSession()).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 502,
      code: 'upstream_unavailable',
    });
  });
});

describe('verifySession', () => {
  it('returns the session when there is one', async () => {
    apiRequest.mockResolvedValue({ user: PRINCIPAL });

    const { verifySession } = await loadSession();

    await expect(verifySession()).resolves.toMatchObject({
      principal: { email: 'sam@acme.example.com' },
    });
  });

  it('sends a caller with no session to sign in, keeping where they were going', async () => {
    const { verifySession, refuse } = await loadSession();

    apiRequest.mockRejectedValue(refuse(401, 'unauthenticated'));

    await expect(verifySession()).rejects.toMatchObject({
      target: '/login?next=%2Fsettings%2Fpeople',
    });
  });
});

describe('requireAnyPermission', () => {
  it('returns null for a signed-in principal who lacks every one of them', async () => {
    apiRequest.mockResolvedValue({ user: { ...PRINCIPAL, role: 'agent', permissions: [] } });

    const { requireAnyPermission } = await loadSession();

    await expect(requireAnyPermission(['user:set_role'])).resolves.toBeNull();
  });

  /**
   * A signed-out visitor must not be told "you do not have access" — that is the
   * wrong answer for someone who has not had the chance to say who they are.
   */
  it('redirects rather than returning null when there is no session at all', async () => {
    const { requireAnyPermission, refuse } = await loadSession();

    apiRequest.mockRejectedValue(refuse(401, 'unauthenticated'));

    await expect(requireAnyPermission(['user:set_role'])).rejects.toBeInstanceOf(RedirectSignal);
  });
});
