import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  EDGE_AUTH_HEADER,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME_SECURE,
  TENANT_HOST_HEADER,
} from '@whatsappcrm/contracts';
import { REQUEST_PATH_HEADER } from '@/lib/session/session-paths';
import { proxy } from './proxy';

/**
 * The optimistic half of the route guard, and the only place the browser's own
 * API calls can still be told which tenant they are for. These cases are the
 * ones a reviewer cannot check by clicking: an unauthenticated deep link, the
 * loop a naive "redirect signed-out users" rule creates around the sign-in
 * screen itself, the header the authoritative half depends on, and a caller that
 * tries to name its own tenant.
 */

const ORIGIN = 'https://acme.example.com';
const HOST = 'acme.example.com';
const HTTP_TEMPORARY_REDIRECT = 307;

// Hoisted above the `vi.mock` factory, so the secret is defined by the time it runs.
const { env, SECRET } = vi.hoisted(() => {
  const secret = 'shared-edge-secret';
  const env: { enableRoleStub: boolean; trustedProxySecret: string | null } = {
    enableRoleStub: false,
    trustedProxySecret: secret,
  };

  return { SECRET: secret, env };
});

vi.mock('@/lib/config/env', () => ({ webEnv: env }));

function request(
  path: string,
  cookie?: { name: string; value: string },
  headers?: Record<string, string>,
): NextRequest {
  const next = new NextRequest(new URL(path, ORIGIN), {
    headers: { host: HOST, ...headers },
  });

  if (cookie !== undefined) {
    next.cookies.set(cookie.name, cookie.value);
  }

  return next;
}

/** How Next surfaces a request header the proxy overrode, as `withRequestPath` shows. */
function overriddenRequestHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
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

    expect(overriddenRequestHeader(response, REQUEST_PATH_HEADER)).toBe(
      '/settings/people?tab=teams',
    );
  });
});

/**
 * The browser's calls to the API do not go through `lib/api/http.ts` — they are
 * proxied to the API origin by `next.config.mjs`, which replaces `Host` with the
 * destination's. This is the last point at which the tenant host is still known.
 */
describe('proxy, on the browser path to the API', () => {
  it('names the tenant and proves the naming', () => {
    const response = proxy(request('/api/v1/auth/login'));

    expect(overriddenRequestHeader(response, TENANT_HOST_HEADER)).toBe(HOST);
    expect(overriddenRequestHeader(response, EDGE_AUTH_HEADER)).toBe(SECRET);
  });

  /**
   * The whole of the trust boundary. A caller that names its own tenant and
   * guesses at the proof must be overwritten, not appended to — otherwise a
   * forwarded-header splice picks the tenant its request resolves to.
   */
  it('overwrites a tenant the caller tried to name for itself', () => {
    const response = proxy(
      request('/api/v1/auth/login', undefined, {
        [TENANT_HOST_HEADER]: 'evil.example.com',
        [EDGE_AUTH_HEADER]: 'guessed',
      }),
    );

    expect(overriddenRequestHeader(response, TENANT_HOST_HEADER)).toBe(HOST);
    expect(overriddenRequestHeader(response, EDGE_AUTH_HEADER)).toBe(SECRET);
  });

  /**
   * An API call answered with a redirect to an HTML sign-in page turns a clean
   * 401 into a parse failure in the caller. The API authenticates these itself.
   */
  it('never redirects an API call to sign in, even with no session cookie', () => {
    const response = proxy(request('/api/v1/conversations'));

    expect(response.status).not.toBe(HTTP_TEMPORARY_REDIRECT);
    expect(response.headers.get('location')).toBeNull();
  });

  it('strips a forged pair rather than passing it on when no secret is configured', () => {
    env.trustedProxySecret = null;

    const response = proxy(
      request('/api/v1/auth/login', undefined, {
        [TENANT_HOST_HEADER]: 'evil.example.com',
        [EDGE_AUTH_HEADER]: 'guessed',
      }),
    );

    expect(overriddenRequestHeader(response, TENANT_HOST_HEADER)).toBeNull();
    expect(overriddenRequestHeader(response, EDGE_AUTH_HEADER)).toBeNull();

    env.trustedProxySecret = SECRET;
  });
});
