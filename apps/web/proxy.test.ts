import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, SESSION_COOKIE_NAME_SECURE } from '@whatsappcrm/contracts';
import { REQUEST_PATH_HEADER } from '@/lib/session/session-paths';
import { proxy } from './proxy';

/**
 * The optimistic half of the route guard. These cases are the ones a reviewer
 * cannot check by clicking: an unauthenticated deep link, the loop a naive
 * "redirect signed-out users" rule creates around the sign-in screen itself, and
 * the header the authoritative half depends on.
 */

const ORIGIN = 'https://acme.example.com';
const HTTP_TEMPORARY_REDIRECT = 307;

function request(path: string, cookie?: { name: string; value: string }): NextRequest {
  const next = new NextRequest(new URL(path, ORIGIN));

  if (cookie !== undefined) {
    next.cookies.set(cookie.name, cookie.value);
  }

  return next;
}

/** Only the *presence* of a cookie is checked here, so the value is arbitrary. */
const SESSION_COOKIE = { name: SESSION_COOKIE_NAME_SECURE, value: 'opaque-session-id' };

describe('proxy', () => {
  it('sends a visitor with no session cookie to sign in', () => {
    const response = proxy(request('/inbox'));

    expect(response.status).toBe(HTTP_TEMPORARY_REDIRECT);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login?next=%2Finbox`);
  });

  it('keeps the query string, so a filtered deep link survives signing in', () => {
    const response = proxy(request('/settings/people?tab=teams'));

    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/login?next=%2Fsettings%2Fpeople%3Ftab%3Dteams`,
    );
  });

  it('lets a request carrying a session cookie through', () => {
    const response = proxy(request('/inbox', SESSION_COOKIE));

    expect(response.headers.get('location')).toBeNull();
  });

  /**
   * The API names the cookie from its own `SESSION_COOKIE_SECURE` flag, which this
   * process cannot read. Missing the local spelling would make every request in
   * local development a redirect to sign-in.
   */
  it('accepts the development cookie spelling as well as the secure one', () => {
    const response = proxy(request('/inbox', { name: SESSION_COOKIE_NAME, value: 'x' }));

    expect(response.headers.get('location')).toBeNull();
  });

  it('does not bounce a signed-out visitor off the sign-in screen, which would loop', () => {
    const response = proxy(request('/login?next=%2Finbox'));

    expect(response.headers.get('location')).toBeNull();
  });

  it('lets an invitee with no account reach the invite screen', () => {
    const response = proxy(request('/invite'));

    expect(response.headers.get('location')).toBeNull();
  });

  it('publishes the requested path so the server guard can name it in ?next=', () => {
    const response = proxy(request('/settings/people?tab=teams', SESSION_COOKIE));

    expect(response.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`)).toBe(
      '/settings/people?tab=teams',
    );
  });
});
