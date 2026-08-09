import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, apiFetch } from './api';

function mockFetch(status: number, body: unknown, jsonParses = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'Bad Gateway',
      json: async () => {
        if (!jsonParses) {
          throw new SyntaxError('not json');
        }
        return body;
      },
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('returns the parsed body on success', async () => {
    mockFetch(200, { status: 'ok' });

    await expect(apiFetch<{ status: string }>('/health')).resolves.toEqual({ status: 'ok' });
  });

  it('maps the error envelope onto ApiRequestError', async () => {
    mockFetch(404, {
      error: {
        code: 'conversation_not_found',
        message: 'No such conversation',
        requestId: 'req_7',
      },
    });

    await expect(apiFetch('/conversations/1')).rejects.toMatchObject({
      status: 404,
      code: 'conversation_not_found',
      requestId: 'req_7',
    });
  });

  it('does not claim our error shape when the response is not JSON', async () => {
    mockFetch(502, null, false);

    await expect(apiFetch('/health')).rejects.toBeInstanceOf(ApiRequestError);
    await expect(apiFetch('/health')).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('flags a JSON response that does not match the envelope', async () => {
    mockFetch(500, { oops: true });

    await expect(apiFetch('/health')).rejects.toMatchObject({ code: 'malformed_error' });
  });
});
