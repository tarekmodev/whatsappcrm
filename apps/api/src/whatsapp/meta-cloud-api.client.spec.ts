import type { ConfigService } from '@nestjs/config';
import { MetaCloudApiClient } from './meta-cloud-api.client';
import {
  MetaAuthenticationError,
  MetaRateLimitedError,
  MetaRequestRejectedError,
  MetaUnavailableError,
} from './meta-cloud-api.errors';

/**
 * The client against mocked Meta responses. Two things are asserted throughout:
 * the request that goes out — Meta rejects a body that is nearly right — and the
 * classification of what comes back, because "retry this" and "stop retrying
 * this" are different behaviours one layer up.
 */

const BASE_URL = 'https://graph.test';
const VERSION = 'v23.0';
const TIMEOUT_MS = 5_000;

const PHONE_NUMBER_ID = '15550001111';
const WABA_ID = '102290129340398';
const ACCESS_TOKEN = 'a-meta-access-token';
const RECIPIENT = '+966501234567';
const WAMID = 'wamid.HBgLOTY2NTAxMjM0NTY3FQIAERgS';

const CONFIG = {
  getOrThrow: (name: string) =>
    ({
      META_GRAPH_API_BASE_URL: BASE_URL,
      META_GRAPH_API_VERSION: VERSION,
      META_GRAPH_API_TIMEOUT_MS: TIMEOUT_MS,
    })[name],
} as unknown as ConfigService;

/** A `fetch` result, with only the surface the client actually reads. */
function metaResponds(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: () => Promise.resolve(body),
  };
}

const ACCEPTED = { messaging_product: 'whatsapp', messages: [{ id: WAMID }] };

describe('MetaCloudApiClient', () => {
  let fetchMock: jest.Mock;
  let client: MetaCloudApiClient;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    client = new MetaCloudApiClient(CONFIG);
  });

  /** The single `fetch` call the client made, as `[url, init]`. */
  function callArgs(): [string, RequestInit] {
    const [call] = fetchMock.mock.calls as [string, RequestInit][];

    if (call === undefined) {
      throw new Error('fetch was never called');
    }

    return call;
  }

  function sentBody(): Record<string, unknown> {
    const { body } = callArgs()[1];

    if (typeof body !== 'string') {
      throw new Error('the request body was not a JSON string');
    }

    return JSON.parse(body) as Record<string, unknown>;
  }

  function sendHello() {
    return client.sendText({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: ACCESS_TOKEN,
      to: RECIPIENT,
      body: 'hello',
    });
  }

  describe('sending a text message', () => {
    beforeEach(() => fetchMock.mockResolvedValue(metaResponds(200, ACCEPTED)));

    it("returns Meta's message id, which is what every later status webhook is matched on", async () => {
      await expect(sendHello()).resolves.toEqual({ providerMessageId: WAMID });
    });

    it('posts to the pinned version and the number, with the token as a bearer', async () => {
      await sendHello();

      const [url, init] = callArgs();

      expect(url).toBe(`${BASE_URL}/${VERSION}/${PHONE_NUMBER_ID}/messages`);
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ authorization: `Bearer ${ACCESS_TOKEN}` });
    });

    it('bounds the call with a timeout, so a slow Meta cannot hold a worker open', async () => {
      await sendHello();

      expect(callArgs()[1].signal).toBeDefined();
    });

    it('sends the envelope Meta requires', async () => {
      await sendHello();

      expect(sentBody()).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: RECIPIENT,
        type: 'text',
        text: { body: 'hello', preview_url: false },
      });
    });
  });

  describe('sending media', () => {
    beforeEach(() => fetchMock.mockResolvedValue(metaResponds(200, ACCEPTED)));

    it('nests the payload under the media type, addressed by link', async () => {
      await client.sendMedia({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: ACCESS_TOKEN,
        to: RECIPIENT,
        kind: 'image',
        media: { link: 'https://cdn.test/a.jpg' },
        caption: 'a caption',
      });

      expect(sentBody()).toMatchObject({
        type: 'image',
        image: { link: 'https://cdn.test/a.jpg', caption: 'a caption' },
      });
    });

    it('addresses media Meta already holds by id instead', async () => {
      await client.sendMedia({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: ACCESS_TOKEN,
        to: RECIPIENT,
        kind: 'document',
        media: { mediaId: '9876' },
        filename: 'invoice.pdf',
      });

      expect(sentBody()).toMatchObject({
        type: 'document',
        document: { id: '9876', filename: 'invoice.pdf' },
      });
    });
  });

  describe('sending a template', () => {
    beforeEach(() => fetchMock.mockResolvedValue(metaResponds(200, ACCEPTED)));

    it('maps positional variables onto body parameters', async () => {
      await client.sendTemplate({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: ACCESS_TOKEN,
        to: RECIPIENT,
        templateName: 'order_update',
        languageCode: 'en_US',
        variables: ['A-1001', 'tomorrow'],
      });

      expect(sentBody()).toMatchObject({
        type: 'template',
        template: {
          name: 'order_update',
          language: { code: 'en_US' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: 'A-1001' },
                { type: 'text', text: 'tomorrow' },
              ],
            },
          ],
        },
      });
    });

    it('omits components entirely when there is nothing to substitute', async () => {
      await client.sendTemplate({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: ACCESS_TOKEN,
        to: RECIPIENT,
        templateName: 'hello_world',
        languageCode: 'en_US',
      });

      // Meta rejects an empty `components` array on a template with no
      // placeholders, so absent is not the same as empty here.
      expect(sentBody().template).not.toHaveProperty('components');
    });
  });

  describe('when Meta rejects the credential', () => {
    const OAUTH_FAILURE = {
      error: {
        message: 'Error validating access token: Session has expired',
        type: 'OAuthException',
        code: 190,
        fbtrace_id: 'Az8...',
      },
    };

    it('classifies an expired token as authentication, even behind a 400', async () => {
      // Meta answers 400 for an expired token often enough that classifying on
      // status alone would retry a dead credential forever.
      fetchMock.mockResolvedValue(metaResponds(400, OAUTH_FAILURE));

      await expect(sendHello()).rejects.toBeInstanceOf(MetaAuthenticationError);
    });

    it('classifies a 401 with no body as authentication too', async () => {
      fetchMock.mockResolvedValue(metaResponds(401, null));

      await expect(
        client.listMessageTemplates({ wabaId: WABA_ID, accessToken: ACCESS_TOKEN }),
      ).rejects.toBeInstanceOf(MetaAuthenticationError);
    });

    it("carries Meta's trace id, and never the token", async () => {
      fetchMock.mockResolvedValue(metaResponds(400, OAUTH_FAILURE));

      const error = await sendHello().catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(MetaAuthenticationError);
      expect((error as MetaAuthenticationError).detail?.traceId).toBe('Az8...');
      expect(JSON.stringify(error)).not.toContain(ACCESS_TOKEN);
    });
  });

  describe('when Meta throttles', () => {
    it('classifies a 429 as rate limited and keeps Retry-After', async () => {
      fetchMock.mockResolvedValue(
        metaResponds(
          429,
          { error: { message: 'Too many calls', code: 613 } },
          { 'retry-after': '30' },
        ),
      );

      const error = await sendHello().catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(MetaRateLimitedError);
      expect((error as MetaRateLimitedError).retryAfterSeconds).toBe(30);
    });

    it("classifies Meta's own throttling code behind a 400", async () => {
      // 130429 is the per-number throughput cap and arrives with a 400. Treated
      // as a permanent rejection it would drop a message that was only early.
      fetchMock.mockResolvedValue(
        metaResponds(400, { error: { message: 'Rate limit hit', code: 130429 } }),
      );

      await expect(sendHello()).rejects.toBeInstanceOf(MetaRateLimitedError);
    });
  });

  describe('when Meta refuses or does not answer', () => {
    it('reports a plain rejection as rejected, so it is not retried', async () => {
      fetchMock.mockResolvedValue(
        metaResponds(400, { error: { message: 'Template name does not exist', code: 132001 } }),
      );

      await expect(
        client.sendTemplate({
          phoneNumberId: PHONE_NUMBER_ID,
          accessToken: ACCESS_TOKEN,
          to: RECIPIENT,
          templateName: 'nope',
          languageCode: 'en_US',
        }),
      ).rejects.toBeInstanceOf(MetaRequestRejectedError);
    });

    it('reports a 5xx as transient', async () => {
      fetchMock.mockResolvedValue(metaResponds(503, null));

      await expect(sendHello()).rejects.toBeInstanceOf(MetaUnavailableError);
    });

    it('reports a timeout as transient without quoting the request URL', async () => {
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      fetchMock.mockRejectedValue(timeout);

      const error = await sendHello().catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(MetaUnavailableError);
      expect((error as MetaUnavailableError).message).toContain('timed out');
      expect((error as MetaUnavailableError).message).not.toContain(PHONE_NUMBER_ID);
    });

    it('treats a 200 with no message id as transient rather than recording an untrackable send', async () => {
      fetchMock.mockResolvedValue(metaResponds(200, { messaging_product: 'whatsapp' }));

      await expect(sendHello()).rejects.toBeInstanceOf(MetaUnavailableError);
    });
  });

  describe('listing templates', () => {
    it('asks for the fields it stores, and reports the next cursor', async () => {
      fetchMock.mockResolvedValue(
        metaResponds(200, {
          data: [
            {
              id: '1001',
              name: 'order_update',
              language: 'en_US',
              category: 'UTILITY',
              status: 'APPROVED',
              components: [{ type: 'BODY', text: 'Order {{1}}' }],
            },
          ],
          paging: { cursors: { after: 'CURSOR2' }, next: 'https://graph.test/next' },
        }),
      );

      const page = await client.listMessageTemplates({
        wabaId: WABA_ID,
        accessToken: ACCESS_TOKEN,
        after: 'CURSOR1',
      });

      const [url] = callArgs();

      expect(url).toContain(`${VERSION}/${WABA_ID}/message_templates`);
      expect(url).toContain('after=CURSOR1');
      expect(page.nextAfter).toBe('CURSOR2');
      expect(page.templates).toEqual([
        {
          name: 'order_update',
          language: 'en_US',
          category: 'UTILITY',
          status: 'approved',
          components: [{ type: 'BODY', text: 'Order {{1}}' }],
          providerTemplateId: '1001',
        },
      ]);
    });

    it('stops at the last page even though Meta still sends a cursor', async () => {
      // Meta returns `cursors.after` on the final page too. Following it
      // unconditionally re-reads that page forever.
      fetchMock.mockResolvedValue(
        metaResponds(200, { data: [], paging: { cursors: { after: 'LAST' } } }),
      );

      await expect(
        client.listMessageTemplates({ wabaId: WABA_ID, accessToken: ACCESS_TOKEN }),
      ).resolves.toMatchObject({ nextAfter: null });
    });

    it('reports an unmodelled status as null rather than guessing at it', async () => {
      fetchMock.mockResolvedValue(
        metaResponds(200, {
          data: [{ name: 'appealed', language: 'en_US', status: 'IN_APPEAL' }],
          paging: {},
        }),
      );

      const page = await client.listMessageTemplates({
        wabaId: WABA_ID,
        accessToken: ACCESS_TOKEN,
      });

      expect(page.templates).toEqual([expect.objectContaining({ name: 'appealed', status: null })]);
    });

    it('drops a template with no name or language, which could never be keyed', async () => {
      fetchMock.mockResolvedValue(
        metaResponds(200, { data: [{ status: 'APPROVED' }, null, 'nonsense'], paging: {} }),
      );

      await expect(
        client.listMessageTemplates({ wabaId: WABA_ID, accessToken: ACCESS_TOKEN }),
      ).resolves.toMatchObject({ templates: [] });
    });
  });
});
