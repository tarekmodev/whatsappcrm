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

  it('refuses the backslash spelling some browsers normalise to //', () => {
    expect(parseRedirectPath('/\\evil.example.com', FALLBACK)).toBe(FALLBACK);
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
