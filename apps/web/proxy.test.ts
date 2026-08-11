import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, SESSION_COOKIE_NAME_SECURE } from '@whatsappcrm/contracts';
import { EDGE_AUTH_HEADER, FORWARDED_HOST_HEADER } from '@/lib/api/tenant-forwarding';
import { REQUEST_PATH_HEADER } from '@/lib/session/session-paths';
import { proxy } from './proxy';

/**
 * The optimistic half of the route guard, and the tenant headers the browser's
 * API path depends on. These cases are the ones a reviewer cannot check by
 * clicking: an unauthenticated deep link, the loop a naive "redirect signed-out
 * users" rule creates around the sign-in screen itself, the header the
 * authoritative half depends on, and the pair a forged request must not keep.
 *
 * That the pair survives Next's rewrite all the way to the API is a claim about
 * Next rather than about this function, so it is asserted end to end in
 * `proxy.int-test.ts` instead.
 */

const ORIGIN = 'https://acme.example.com';
const TENANT_HOST = 'acme.example.com';
const HTTP_TEMPORARY_REDIRECT = 307;

const { env } = vi.hoisted(() => ({
  env: { trustedProxySecret: null as string | null, enableRoleStub: false },
}));

vi.mock('@/lib/config/env', () => ({
  webEnv: {
    get trustedProxySecret(): string | null {
      return env.trustedProxySecret;
    },
    get enableRoleStub(): boolean {
      return env.enableRoleStub;
    },
  },
}));

afterEach(() => {
  env.trustedProxySecret = null;
});

function request(
  path: string,
  cookie?: { name: string; value: string },
  headers?: Record<string, string>,
): NextRequest {
  const next = new NextRequest(new URL(path, ORIGIN), {
    headers: { host: TENANT_HOST, ...headers },
  });

  if (cookie !== undefined) {
    next.cookies.set(cookie.name, cookie.value);
  }

  return next;
}

/** What Next reads back off the response to rewrite the outgoing request. */
function forwardedHeader(response: NextResponseLike, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

function overriddenHeaders(response: NextResponseLike): string[] {
  return (response.headers.get('x-middleware-override-headers') ?? '').split(',');
}

type NextResponseLike = { headers: Headers };

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

describe('proxy, on the browser path to the API', () => {
  it('names the tenant and proves the claim on the way to the rewrite', () => {
    env.trustedProxySecret = 'edge-secret';

    const response = proxy(request('/api/v1/auth/session'));

    expect(forwardedHeader(response, FORWARDED_HOST_HEADER)).toBe(TENANT_HOST);
    expect(forwardedHeader(response, EDGE_AUTH_HEADER)).toBe('edge-secret');
  });

  /**
   * The whole reason `/api/*` was excluded from the matcher before this branch
   * existed: an XHR answered with an HTML sign-in page is a parse failure in the
   * caller rather than the API's clean 401.
   */
  it('never redirects an API call, even with no session cookie', () => {
    const response = proxy(request('/api/v1/conversations'));

    expect(response.status).not.toBe(HTTP_TEMPORARY_REDIRECT);
    expect(response.headers.get('location')).toBeNull();
  });

  /**
   * `x-edge-auth` is the one credential that makes `x-forwarded-host` believable,
   * so a value that arrived from the browser must not reach the API — otherwise
   * the pair proves nothing and any visitor could name any tenant.
   */
  it('replaces a forged credential rather than forwarding it', () => {
    env.trustedProxySecret = 'edge-secret';

    const response = proxy(
      request('/api/v1/auth/login', undefined, {
        [EDGE_AUTH_HEADER]: 'guessed',
        [FORWARDED_HOST_HEADER]: 'victim.example.com',
      }),
    );

    expect(forwardedHeader(response, EDGE_AUTH_HEADER)).toBe('edge-secret');
    expect(forwardedHeader(response, FORWARDED_HOST_HEADER)).toBe(TENANT_HOST);
  });

  it('strips a forged credential even when this tier has no secret to replace it with', () => {
    const response = proxy(
      request('/api/v1/auth/login', undefined, { [EDGE_AUTH_HEADER]: 'guessed' }),
    );

    expect(overriddenHeaders(response)).not.toContain(EDGE_AUTH_HEADER);
  });

  it('leaves the request otherwise intact, so the session cookie still reaches the API', () => {
    const response = proxy(request('/api/v1/conversations', SESSION_COOKIE));

    expect(overriddenHeaders(response)).toContain('cookie');
  });
});
