import { describe, expect, it } from 'vitest';
import { routes } from '@/lib/routes';
import { isPublicPath } from '@/lib/session/session-paths';
import { PLATFORM_ADMIN_COOKIE_NAME, isAdminPath, isAdminPublicPath } from './admin-paths';

/**
 * The seam between the two credentials this app has. `proxy.ts` reads these to
 * decide which one a request is missing, so a mistake here sends an operator to a
 * tenant's sign-in screen — or a tenant's user into the operator console's shell.
 */

describe('isAdminPath', () => {
  it.each([
    '/admin',
    '/admin/tenants',
    '/admin/tenants/northwind',
    '/admin/domains',
    '/admin/sign-in',
  ])('claims %s', (pathname) => {
    expect(isAdminPath(pathname)).toBe(true);
  });

  /**
   * Prefix matching on the *segment*, not on the string: a tenant route that
   * merely starts with the same letters is not the operator console, and
   * claiming it would take a signed-in user to a credential form.
   */
  it.each(['/', '/inbox', '/administration', '/settings/admin'])(
    'leaves %s to the tenant guard',
    (pathname) => {
      expect(isAdminPath(pathname)).toBe(false);
    },
  );
});

describe('isAdminPublicPath', () => {
  it('lets the credential form through, or nobody could ever present one', () => {
    expect(isAdminPublicPath(routes.adminSignIn())).toBe(true);
  });

  it.each(['/admin', '/admin/tenants', '/admin/domains', '/admin/webhook-events'])(
    'gates %s',
    (pathname) => {
      expect(isAdminPublicPath(pathname)).toBe(false);
    },
  );

  /**
   * `routes.adminSignIn()` takes a `?next=`, and `pathname` never carries a
   * query — this is the pair that has to agree about that.
   */
  it('is a path comparison, so the redirect target it is built from still matches', () => {
    expect(routes.adminSignIn({ redirectTo: '/admin/domains' })).toContain(routes.adminSignIn());
  });
});

describe('the two credential surfaces', () => {
  /**
   * The operator console must never be on the *tenant* public list: that list is
   * what lets a request through with no session at all, and every screen below
   * `/admin` is behind a platform credential instead.
   */
  it.each(['/admin', '/admin/sign-in', '/admin/tenants'])(
    'keeps %s off the tenant public list',
    (pathname) => {
      expect(isPublicPath(pathname)).toBe(false);
    },
  );

  /**
   * Scoped to `/admin`, so the browser never attaches the platform token to
   * `/api/*` — which `next.config.mjs` rewrites straight to the API host. The
   * name is asserted because `proxy.ts` and the server-side store both spell it,
   * and they must not drift.
   */
  it('names the cookie once', () => {
    expect(PLATFORM_ADMIN_COOKIE_NAME).toBe('wac_platform_admin');
  });
});
