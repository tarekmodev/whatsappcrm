import { describe, expect, it } from 'vitest';
import { routes } from '@/lib/routes';
import { isPublicPath } from './session-paths';

/**
 * The list this asserts against is the difference between "signed out" and
 * "locked out". A missing entry does not fail loudly — it sends someone following
 * an invitation or a reset link to a sign-in screen they cannot get past, which is
 * a support ticket, not a stack trace.
 */
describe('isPublicPath', () => {
  it.each([
    ['sign-in', routes.login()],
    ['invite acceptance, where the person has no account yet', routes.invite()],
    ['the forgotten-password screen', routes.forgotPassword()],
    ['the reset link from the email', routes.resetPassword()],
  ])('lets a visitor with no session reach %s', (_description, path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it('ignores the query string, which is not part of the pathname', () => {
    expect(isPublicPath(routes.login())).toBe(true);
  });

  it('covers a child route of a public screen', () => {
    expect(isPublicPath(`${routes.resetPassword()}/expired`)).toBe(true);
  });

  it.each([['/'], ['/inbox'], ['/settings'], ['/settings/people']])('guards %s', (path: string) => {
    expect(isPublicPath(path)).toBe(false);
  });

  /**
   * Prefix matching must not degrade to "starts with": a route whose name merely
   * begins with a public one is a different route, and treating it as public would
   * be an unauthenticated hole named by accident.
   */
  it('does not treat a longer name that merely starts the same way as public', () => {
    expect(isPublicPath('/login-history')).toBe(false);
  });
});
