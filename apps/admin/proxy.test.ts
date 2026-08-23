import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { REQUEST_PATH_HEADER } from '@/lib/session/session-paths';
import { CREDENTIAL_COOKIE_NAME, CREDENTIAL_COOKIE_NAME_SECURE } from '~/lib/credential-paths';
import { proxy } from './proxy';

/**
 * The optimistic half of the operator console's route guard.
 *
 * These are the cases a reviewer cannot check by clicking: an unauthenticated
 * deep link, the loop a naive "redirect everyone without a credential" rule
 * creates around the credential screen itself, and the header the authoritative
 * half depends on to know where the operator was going.
 */

const ORIGIN = 'https://admin.example.com';
const HOST = 'admin.example.com';
const HTTP_TEMPORARY_REDIRECT = 307;

function request(path: string, cookie?: { name: string; value: string }): NextRequest {
  const next = new NextRequest(new URL(path, ORIGIN), { headers: { host: HOST } });

  if (cookie !== undefined) {
    next.cookies.set(cookie.name, cookie.value);
  }

  return next;
}

describe('the credential guard', () => {
  it('turns a deep link away and carries where it was going', () => {
    const response = proxy(request('/tenants/northwind?cursor=abc'));

    expect(response.status).toBe(HTTP_TEMPORARY_REDIRECT);
    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/sign-in?next=%2Ftenants%2Fnorthwind%3Fcursor%3Dabc`,
    );
  });

  /**
   * The loop case. Without it the credential screen redirects to itself forever,
   * and an operator with no credential can never present one.
   */
  it('does not bounce a request for the credential screen off it', () => {
    expect(proxy(request('/sign-in')).status).not.toBe(HTTP_TEMPORARY_REDIRECT);
  });

  it.each([CREDENTIAL_COOKIE_NAME_SECURE, CREDENTIAL_COOKIE_NAME])(
    'lets a request carrying %s through',
    (name) => {
      const response = proxy(request('/tenants', { name, value: 'a-token' }));

      expect(response.status).not.toBe(HTTP_TEMPORARY_REDIRECT);
    },
  );

  /**
   * Presence only. Whether the value is still *accepted* is `lib/api/admin.ts`'s
   * question, and its answer is a state rather than a redirect — so a rotated
   * token must not be caught here.
   */
  it('does not judge the credential, only that there is one', () => {
    const response = proxy(request('/tenants', { name: CREDENTIAL_COOKIE_NAME, value: 'stale' }));

    expect(response.status).not.toBe(HTTP_TEMPORARY_REDIRECT);
  });

  it('publishes the requested path for the server render', () => {
    const response = proxy(
      request('/domains?status=live', { name: CREDENTIAL_COOKIE_NAME, value: 'a-token' }),
    );

    expect(response.headers.get('x-middleware-request-' + REQUEST_PATH_HEADER)).toBe(
      '/domains?status=live',
    );
  });

  /**
   * Always `set`, never `append`: a client that sent this header itself must not
   * be able to choose the path the redirect returns them to.
   */
  it('overwrites a request path a caller tried to supply', () => {
    const forged = new NextRequest(new URL('/tenants', ORIGIN), {
      headers: { host: HOST, [REQUEST_PATH_HEADER]: '/somewhere-else' },
    });
    forged.cookies.set(CREDENTIAL_COOKIE_NAME, 'a-token');

    const response = proxy(forged);

    expect(response.headers.get('x-middleware-request-' + REQUEST_PATH_HEADER)).toBe('/tenants');
  });
});
