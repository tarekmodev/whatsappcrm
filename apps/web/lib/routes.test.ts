import { describe, expect, it } from 'vitest';
import { parseRedirectPath, routes } from './routes';

/**
 * `?next=` is attacker-controlled: anybody can send a link to the sign-in screen.
 * Following it blindly hands a user who has *just* authenticated to whatever host
 * the link named, which is exactly when they are least likely to look at the
 * address bar.
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

describe('routes.login', () => {
  it('is a bare path when there is nowhere in particular to return to', () => {
    expect(routes.login()).toBe('/login');
  });

  it('carries the return path encoded, not concatenated', () => {
    expect(routes.login({ redirectTo: '/settings/people?tab=teams' })).toBe(
      '/login?next=%2Fsettings%2Fpeople%3Ftab%3Dteams',
    );
  });
});
