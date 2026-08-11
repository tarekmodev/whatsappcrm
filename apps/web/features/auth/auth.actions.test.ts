import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/http';
import { REQUEST_PATH_HEADER } from '@/lib/session/session-paths';
import { content } from '@/content/en';
import { changePasswordAction } from './auth.actions';

/**
 * The password-change action end to end — action, resource module, authenticated
 * transport and the session-expiry rule underneath it — because TAR-163 lived in
 * the seam between them and no single unit could see it.
 *
 * The distinction being pinned: a wrong `currentPassword` is an answer *this
 * form* renders, and a lost session is a navigation. Both arrive as a 401.
 */

const { apiRequest, verifySession } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  verifySession: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/api/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/http')>()),
  apiRequest,
}));

vi.mock('@/lib/session/session', () => ({ verifySession }));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => ({ value: 'opaque-session-id' }) }),
  headers: () => Promise.resolve(new Headers({ [REQUEST_PATH_HEADER]: '/settings/security' })),
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
  // The real one recognises Next's own control-flow throws; this one recognises
  // the stand-in above, which is the same contract from the action's side.
  unstable_rethrow: (error: unknown) => {
    if (error instanceof RedirectSignal) {
      throw error;
    }
  },
}));

const INPUT = { currentPassword: 'the-old-passphrase', newPassword: 'a-perfectly-fine-passphrase' };
const WRONG_PASSWORD_MESSAGE = 'The current password is incorrect.';

afterEach(() => {
  vi.clearAllMocks();
});

describe('changePasswordAction', () => {
  it('reports success when the API takes the change', async () => {
    apiRequest.mockResolvedValue(null);

    await expect(changePasswordAction(INPUT)).resolves.toEqual({
      status: 'success',
      data: undefined,
    });
  });

  /**
   * TAR-163. `invalid_credentials` is 401, the same code login uses, and the API
   * leaves the session alone when it answers it. Reading that as an expiry sent
   * the user to sign-in with no message — logged out on their first typo — where
   * the form has an inline error waiting for exactly this.
   */
  it('returns a wrong current password as an inline error, without signing the user out', async () => {
    apiRequest.mockRejectedValue(
      new ApiRequestError(401, 'invalid_credentials', WRONG_PASSWORD_MESSAGE, 'req-1'),
    );

    await expect(changePasswordAction(INPUT)).resolves.toEqual({
      status: 'error',
      message: WRONG_PASSWORD_MESSAGE,
      requestId: 'req-1',
    });
  });

  /** The other half of the same rule: a session that really is gone still navigates. */
  it('lets a lost session become a redirect rather than a message', async () => {
    apiRequest.mockRejectedValue(new ApiRequestError(401, 'unauthenticated', 'Refused', null));

    await expect(changePasswordAction(INPUT)).rejects.toBeInstanceOf(RedirectSignal);
  });

  it('falls back to the generic line for a failure with no copy of its own', async () => {
    apiRequest.mockRejectedValue(new ApiRequestError(502, 'upstream_unavailable', 'Down', null));

    await expect(changePasswordAction(INPUT)).resolves.toMatchObject({
      status: 'error',
      message: content.auth.genericFailure,
    });
  });
});
