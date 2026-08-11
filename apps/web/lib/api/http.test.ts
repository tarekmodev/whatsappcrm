import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, apiRequest } from './http';
import { TENANT_HOST_HEADER } from './tenant-host';

// The mock transport is chosen by `webEnv.useMockApi`, which is false under
// `vitest` unless the flag is set — so these cases exercise the HTTP branch.

let incomingHeaders = new Headers({ host: 'northwind.app.localhost:3000' });

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(incomingHeaders),
}));

beforeEach(() => {
  incomingHeaders = new Headers({ host: 'northwind.app.localhost:3000' });
});

function headersOf(callIndex = 0): Record<string, string> {
  const [, init] = vi.mocked(globalThis.fetch).mock.calls[callIndex] ?? [];

  return (init?.headers ?? {}) as Record<string, string>;
}

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
});

/**
 * The tenant the API resolves is decided entirely by what this transport sends.
 * These cases pin the two properties that makes safe: it is always sent, and it
 * is always the host this process was reached on rather than one the caller
 * asked for.
 */
describe('apiRequest tenant addressing', () => {
  it('forwards the incoming host so the API can resolve the tenant', async () => {
    mockFetch(200, { status: 'ok' });

    await apiRequest({ method: 'GET', path: '/v1/auth/session' });

    expect(headersOf()).toMatchObject({ [TENANT_HOST_HEADER]: 'northwind.app.localhost:3000' });
  });

  it('sends it on unauthenticated calls too, which resolve a tenant just the same', async () => {
    mockFetch(204, undefined);

    await apiRequest({ method: 'POST', path: '/v1/auth/password-reset', body: { email: 'a@b.c' } });

    expect(headersOf()).toMatchObject({ [TENANT_HOST_HEADER]: 'northwind.app.localhost:3000' });
  });

  it('ignores an x-forwarded-host the caller supplied, which would pick their own tenant', async () => {
    incomingHeaders = new Headers({
      host: 'northwind.app.localhost:3000',
      [TENANT_HOST_HEADER]: 'contoso.app.localhost:3000',
    });
    mockFetch(200, { status: 'ok' });

    await apiRequest({ method: 'GET', path: '/v1/auth/session' });

    expect(headersOf()).toMatchObject({ [TENANT_HOST_HEADER]: 'northwind.app.localhost:3000' });
  });

  it('omits the header rather than sending an empty one when there is no host', async () => {
    incomingHeaders = new Headers();
    mockFetch(200, { status: 'ok' });

    await apiRequest({ method: 'GET', path: '/v1/auth/session' });

    expect(headersOf()).not.toHaveProperty(TENANT_HOST_HEADER);
  });
});
