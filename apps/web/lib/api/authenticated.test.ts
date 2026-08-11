import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/http';
import { authenticatedRequest } from './authenticated';

/**
 * The transport that makes the guard unforgettable. Three things must hold for
 * every authenticated call, from any page or action:
 *
 *   1. the session is verified before the request is made;
 *   2. the caller's cookie goes with it, or the API sees an anonymous request and
 *      tenant scoping has nothing to scope by;
 *   3. losing the session mid-flight ends in a sign-in, and every other refusal
 *      reaches the caller intact.
 */

const { apiRequest, verifySession, redirectToLogin } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  verifySession: vi.fn(),
  redirectToLogin: vi.fn(),
}));

vi.mock('@/lib/api/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/http')>()),
  apiRequest,
}));

vi.mock('@/lib/session/session', () => ({ verifySession }));
vi.mock('@/lib/session/login-redirect', () => ({ redirectToLogin }));
vi.mock('@/lib/session/session-cookie', () => ({
  sessionCookieHeaders: () => Promise.resolve({ cookie: '__Host-wac_session=opaque-session-id' }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('authenticatedRequest', () => {
  it('verifies the session before it asks for anything', async () => {
    const order: string[] = [];

    verifySession.mockImplementation(() => {
      order.push('verify');

      return Promise.resolve();
    });
    apiRequest.mockImplementation(() => {
      order.push('request');

      return Promise.resolve({ items: [] });
    });

    await authenticatedRequest({ method: 'GET', path: '/v1/users' });

    expect(order).toEqual(['verify', 'request']);
  });

  it('forwards the caller’s session cookie', async () => {
    apiRequest.mockResolvedValue(null);

    await authenticatedRequest({ method: 'DELETE', path: '/v1/users/1' });

    expect(apiRequest).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/v1/users/1',
      headers: { cookie: '__Host-wac_session=opaque-session-id' },
    });
  });

  it('lets an explicit header from the caller win', async () => {
    apiRequest.mockResolvedValue(null);

    await authenticatedRequest({
      method: 'GET',
      path: '/v1/users',
      headers: { 'idempotency-key': 'k' },
    });

    expect(apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          cookie: '__Host-wac_session=opaque-session-id',
          'idempotency-key': 'k',
        },
      }),
    );
  });

  it('returns the API’s answer untouched on success', async () => {
    apiRequest.mockResolvedValue({ items: [{ id: '1' }], nextCursor: null });

    await expect(authenticatedRequest({ method: 'GET', path: '/v1/users' })).resolves.toEqual({
      items: [{ id: '1' }],
      nextCursor: null,
    });
  });

  /**
   * The session can be revoked between the check and the call — an admin
   * deactivating the account, or a password reset revoking every session. The
   * answer to that is a sign-in, not an error page.
   */
  it.each([
    ['a revoked session', 401, 'unauthenticated'],
    ['a cross-tenant replay', 401, 'tenant_mismatch'],
  ])('sends the user to sign in after %s', async (_case, status, code) => {
    apiRequest.mockRejectedValue(new ApiRequestError(status, code, 'Refused', null));

    await authenticatedRequest({ method: 'GET', path: '/v1/users' });

    expect(redirectToLogin).toHaveBeenCalledOnce();
  });

  /**
   * A caller who holds a valid session and merely lacks a permission gets the
   * explanatory forbidden state. Bouncing them to sign in would tell them to fix
   * the one thing that is not wrong.
   */
  it('leaves a 403 to the caller instead of signing them out', async () => {
    apiRequest.mockRejectedValue(new ApiRequestError(403, 'forbidden', 'Refused', null));

    await expect(authenticatedRequest({ method: 'GET', path: '/v1/users' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  /**
   * TAR-163. `POST /v1/auth/password` answers a wrong `currentPassword` with 401
   * `invalid_credentials` — the same code login uses — and does not touch the
   * session. Redirecting on it signed the user out of `/settings/security`
   * instead of letting the form show the inline error it already renders.
   */
  it('leaves a wrong current password to the caller instead of signing them out', async () => {
    apiRequest.mockRejectedValue(
      new ApiRequestError(401, 'invalid_credentials', 'The current password is incorrect.', null),
    );

    await expect(
      authenticatedRequest({ method: 'POST', path: '/v1/auth/password' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it('leaves an unreachable API to the caller, so it can be retried', async () => {
    apiRequest.mockRejectedValue(new ApiRequestError(502, 'upstream_unavailable', 'Down', null));

    await expect(authenticatedRequest({ method: 'GET', path: '/v1/users' })).rejects.toMatchObject({
      code: 'upstream_unavailable',
    });
    expect(redirectToLogin).not.toHaveBeenCalled();
  });
});
