import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDGE_AUTH_HEADER, TENANT_HOST_HEADER } from '@whatsappcrm/contracts';
import { ROLE_STUB_COOKIE_NAME, ROLE_STUB_HEADER } from '@/lib/session/role-stub';
import { ApiRequestError, apiRequest } from './http';

// The mock transport is chosen by `webEnv.useMockApi`, which is false under
// `vitest` unless the flag is set — so these cases exercise the HTTP branch.

const TENANT_HOST = 'northwind.app.localhost:3000';
const EDGE_SECRET = 'shared-edge-secret';

// Hoisted above the `vi.mock` factories, so both are defined by the time they run.
// Mutable, because the role-stub cases below are the same transport under a
// different configuration rather than a different module.
const { env, stubRoleCookie, ROLE_STUB_COOKIE } = vi.hoisted(() => ({
  // Spelled here rather than imported: a `vi.mock` factory runs before the test
  // module's own imports are bound. The case below asserts it against the
  // exported constant, so a rename still fails loudly.
  ROLE_STUB_COOKIE: 'wac_role_stub',
  env: {
    apiBaseUrl: '/api',
    serverApiBaseUrl: 'http://api.test/api',
    trustedProxySecret: 'shared-edge-secret',
    useMockApi: false,
    enableRoleStub: false,
    isProduction: false,
  },
  stubRoleCookie: { value: undefined as string | undefined },
}));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: TENANT_HOST })),
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === ROLE_STUB_COOKIE && stubRoleCookie.value !== undefined
          ? { name, value: stubRoleCookie.value }
          : undefined,
    }),
}));

// A configured secret is the deployed shape; without one the transport sends no
// tenant pair at all, which `tenant-host.test.ts` covers on its own.
vi.mock('@/lib/config/env', () => ({ webEnv: env }));

beforeEach(() => {
  env.enableRoleStub = false;
  env.isProduction = false;
  stubRoleCookie.value = undefined;
});

function mockFetch(status: number, body: unknown, jsonParses = true): void {
  const json = (): Promise<unknown> =>
    jsonParses ? Promise.resolve(body) : Promise.reject(new SyntaxError('not json'));

  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: 'Bad Gateway',
        json,
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest', () => {
  it('returns the parsed body on success', async () => {
    mockFetch(200, { status: 'ok' });

    await expect(apiRequest({ method: 'GET', path: '/health' })).resolves.toEqual({
      status: 'ok',
    });
  });

  it('returns null for a 204, rather than trying to parse an empty body', async () => {
    mockFetch(204, undefined);

    await expect(apiRequest({ method: 'DELETE', path: '/v1/users/1' })).resolves.toBeNull();
  });

  it('maps the error envelope onto ApiRequestError', async () => {
    mockFetch(404, {
      error: {
        code: 'not_found',
        message: 'No such conversation',
        requestId: 'req_7',
      },
    });

    await expect(apiRequest({ method: 'GET', path: '/v1/conversations/1' })).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
      requestId: 'req_7',
    });
  });

  it('does not claim our error shape when the response is not JSON', async () => {
    mockFetch(502, null, false);

    await expect(apiRequest({ method: 'GET', path: '/health' })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    await expect(apiRequest({ method: 'GET', path: '/health' })).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });

  it('flags a JSON response that does not match the envelope', async () => {
    mockFetch(500, { oops: true });

    await expect(apiRequest({ method: 'GET', path: '/health' })).rejects.toMatchObject({
      code: 'malformed_error',
    });
  });

  it('serialises the body and sends JSON headers', async () => {
    mockFetch(201, { id: 'x' });

    await apiRequest({ method: 'POST', path: '/v1/teams', body: { name: 'Billing' } });

    const fetchMock = vi.mocked(globalThis.fetch);
    const [, init] = fetchMock.mock.calls[0] ?? [];

    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"name":"Billing"}');
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  /**
   * Without this the API resolves no tenant and answers `tenant_not_found`, so
   * every server-rendered route 404s the moment the mock transport is off — the
   * blocker this pins down. It goes on *every* call, including the
   * unauthenticated ones, because sign-in and password reset are tenant-scoped
   * too.
   */
  it('names the tenant by forwarding the incoming host', async () => {
    mockFetch(204, undefined);

    await apiRequest({ method: 'POST', path: '/v1/auth/password-reset', body: { email: 'a@b.c' } });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];

    expect(init?.headers).toMatchObject({ [TENANT_HOST_HEADER]: TENANT_HOST });
  });

  it('signs the forwarded host, so the API can tell it came from us', async () => {
    mockFetch(200, {});

    await apiRequest({ method: 'GET', path: '/v1/auth/session' });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];

    expect(init?.headers).toMatchObject({ [EDGE_AUTH_HEADER]: EDGE_SECRET });
  });

  /**
   * Every other header here is a default a caller may replace. This pair is not:
   * it decides which tenant's data comes back, so a call site that could set it
   * from anything request-derived is the tenant spoof the mechanism exists to
   * prevent. `proxy.ts` takes the same position on the browser path.
   */
  it('refuses to let a caller name a different tenant', async () => {
    mockFetch(200, {});

    await apiRequest({
      method: 'GET',
      path: '/v1/auth/session',
      headers: { [TENANT_HOST_HEADER]: 'evil.example.com', [EDGE_AUTH_HEADER]: 'guessed' },
    });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];

    expect(init?.headers).toMatchObject({
      [TENANT_HOST_HEADER]: TENANT_HOST,
      [EDGE_AUTH_HEADER]: EDGE_SECRET,
    });
  });

  it('still lets a caller set any header that is not the tenant pair', async () => {
    mockFetch(200, {});

    await apiRequest({
      method: 'GET',
      path: '/v1/auth/session',
      headers: { cookie: '__Host-wac_session=opaque', 'content-type': 'text/plain' },
    });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];

    expect(init?.headers).toMatchObject({
      cookie: '__Host-wac_session=opaque',
      'content-type': 'text/plain',
    });
  });
});

/**
 * TAR-366. Server rendering and server actions run on the Next process, which
 * sends no cookies of its own — and while the stub is on there is no
 * `wac_session` for `sessionCookieHeaders` to carry either. Without the header
 * every call arrived with no role at all and the API resolved its default
 * (`admin`), so the switcher moved the chrome and nothing else.
 */
describe('apiRequest under the interim role stub', () => {
  it('spells the cookie the same way the module under test does', () => {
    expect(ROLE_STUB_COOKIE).toBe(ROLE_STUB_COOKIE_NAME);
  });

  it('sends no role header at all when the stub is off', async () => {
    stubRoleCookie.value = 'supervisor';
    mockFetch(200, {});

    await apiRequest({ method: 'GET', path: '/v1/sla-alerts' });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];

    expect(init?.headers).not.toHaveProperty(ROLE_STUB_HEADER);
  });

  it('names the selected role on the call, so the API resolves that principal', async () => {
    env.enableRoleStub = true;
    stubRoleCookie.value = 'supervisor';
    mockFetch(200, {});

    await apiRequest({ method: 'GET', path: '/v1/sla-alerts' });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];

    expect(init?.headers).toMatchObject({ [ROLE_STUB_HEADER]: 'supervisor' });
  });

  /**
   * The same fallback `parseStubRole` applies to the chrome, so an unset or
   * tampered cookie cannot make the two halves disagree.
   */
  it('falls back to the default role when the cookie is absent or unknown', async () => {
    env.enableRoleStub = true;
    mockFetch(200, {});

    await apiRequest({ method: 'GET', path: '/v1/sla-alerts' });

    stubRoleCookie.value = 'superuser';
    await apiRequest({ method: 'GET', path: '/v1/sla-alerts' });

    for (const [, init] of vi.mocked(globalThis.fetch).mock.calls) {
      expect(init?.headers).toMatchObject({ [ROLE_STUB_HEADER]: 'admin' });
    }
  });

  /** Belt and braces: `getSession` already refuses the stub in production. */
  it('sends nothing in production, even with the flag on', async () => {
    env.enableRoleStub = true;
    env.isProduction = true;
    stubRoleCookie.value = 'supervisor';
    mockFetch(200, {});

    await apiRequest({ method: 'GET', path: '/v1/sla-alerts' });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];

    expect(init?.headers).not.toHaveProperty(ROLE_STUB_HEADER);
  });

  /**
   * Same position the tenant pair takes: a call site that could name the role
   * from anything request-derived is an impersonation this exists to prevent.
   */
  it('refuses to let a caller name a different role', async () => {
    env.enableRoleStub = true;
    stubRoleCookie.value = 'agent';
    mockFetch(200, {});

    await apiRequest({
      method: 'GET',
      path: '/v1/sla-alerts',
      headers: { [ROLE_STUB_HEADER]: 'admin' },
    });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];

    expect(init?.headers).toMatchObject({ [ROLE_STUB_HEADER]: 'agent' });
  });
});
