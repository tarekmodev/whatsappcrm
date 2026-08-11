import { describe, expect, it } from 'vitest';
import { parseRedirectPath, routes } from './routes';

describe('routes', () => {
  /**
   * The API builds the link in a password-reset email as
   * `https://{tenantHost}${RESET_PASSWORD_LINK_PATH}#token=…`, with the path
   * declared in `apps/api/src/identity/mailer/mailer.port.ts`. The console cannot
   * import that constant — the two packages do not depend on each other — so this
   * is the assertion that stops the emailed link and the page it points at
   * drifting into a 404 that only shows up in somebody's inbox.
   *
   * Promoting the constant into `@whatsappcrm/contracts` would remove the need
   * for this; it is a contract change and belongs to TAR-53, not here.
   */
  it('serves the reset page on the path the API mails out', () => {
    expect(routes.resetPassword()).toBe('/reset-password');
  });

  it('builds a query string only when there is something to put in it', () => {
    expect(routes.settingsPeople()).toBe('/settings/people');
    expect(routes.settingsPeople({ tab: 'teams' })).toBe('/settings/people?tab=teams');
  });

  it('encodes a search term rather than letting it become a second filter', () => {
    expect(routes.settingsPeople({ q: 'a&b' })).toBe('/settings/people?q=a%26b');
  });
});

describe('routes.login', () => {
  it('is a bare path when there is nowhere in particular to return to', () => {
    expect(routes.login()).toBe('/login');
  });

  it('carries the return path encoded, not concatenated', () => {
    expect(routes.login({ redirectTo: '/settings/people?tab=teams' })).toBe(
      '/login?next=%2Fsettings%2Fpeople%3Ftab%3Dteams',
    );
  });

  /**
   * `redirectToLogin` passes an empty string when the proxy did not run, and
   * relies on this: a `?next=` with nothing in it would make sign-in redirect to
   * the site root instead of its own landing page.
   */
  it('drops an empty return path rather than emitting an empty parameter', () => {
    expect(routes.login({ redirectTo: '' })).toBe('/login');
  });
});

/**
 * `?next=` is attacker-controlled: anybody can send a link to the sign-in screen,
 * and the guard itself writes the parameter from a request header. Following either
 * blindly hands a user who has *just* authenticated to whatever host the value
 * named — which is exactly when they are least likely to check the address bar.
 */
describe('parseRedirectPath', () => {
  const FALLBACK = '/inbox';

  it('keeps an in-app path, query and all', () => {
    expect(parseRedirectPath('/settings/people?tab=teams', FALLBACK)).toBe(
      '/settings/people?tab=teams',
    );
  });

  it('falls back when nothing was asked for', () => {
    expect(parseRedirectPath(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it('refuses an absolute URL', () => {
    expect(parseRedirectPath('https://evil.example.com/inbox', FALLBACK)).toBe(FALLBACK);
  });

  it('refuses a protocol-relative URL, which a browser reads as another host', () => {
    expect(parseRedirectPath('//evil.example.com/inbox', FALLBACK)).toBe(FALLBACK);
  });

  it('refuses the backslash spelling the URL parser reads as //', () => {
    expect(parseRedirectPath('/\\evil.example.com', FALLBACK)).toBe(FALLBACK);
  });

  /**
   * The bypass a string check cannot see: the WHATWG parser strips tab, CR and LF
   * before resolving, so each of these looks like an in-app path to `startsWith`
   * and resolves to `https://evil.example.com/` once the router parses it.
   */
  it.each([
    ['tab', '/\t/evil.example.com'],
    ['newline', '/\n/evil.example.com'],
    ['carriage return', '/\r/evil.example.com'],
    ['tab then backslash', '/\t\\evil.example.com'],
  ])('refuses a host smuggled past a string check with a %s', (_label, value) => {
    expect(parseRedirectPath(value, FALLBACK)).toBe(FALLBACK);
  });

  it('refuses a relative path, which is not a shape this app ever links to', () => {
    expect(parseRedirectPath('inbox', FALLBACK)).toBe(FALLBACK);
  });

  it('returns what the router will resolve, not the raw input', () => {
    expect(parseRedirectPath('/settings/../inbox', FALLBACK)).toBe('/inbox');
  });
});
