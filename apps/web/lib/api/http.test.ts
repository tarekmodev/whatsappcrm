import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDGE_AUTH_HEADER, TENANT_HOST_HEADER } from '@whatsappcrm/contracts';
import { ApiRequestError, apiRequest } from './http';

// The mock transport is chosen by `webEnv.useMockApi`, which is false under
// `vitest` unless the flag is set — so these cases exercise the HTTP branch.

const TENANT_HOST = 'northwind.app.localhost:3000';
const EDGE_SECRET = 'shared-edge-secret';

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: TENANT_HOST })),
}));

// A configured secret is the deployed shape; without one the transport sends no
// tenant pair at all, which `tenant-host.test.ts` covers on its own.
vi.mock('@/lib/config/env', () => ({
  webEnv: {
    apiBaseUrl: '/api',
    serverApiBaseUrl: 'http://api.test/api',
    trustedProxySecret: 'shared-edge-secret',
    useMockApi: false,
    enableRoleStub: false,
    isProduction: false,
  },
}));

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
