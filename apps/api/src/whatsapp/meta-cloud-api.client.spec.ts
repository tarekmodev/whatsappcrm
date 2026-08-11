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
        fileName: 'invoice.pdf',
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

    it('sends the media a header template needs, ahead of the body', async () => {
      // A template with an IMAGE header is unsendable without this component —
      // the failure `headerFormat` is published to prevent.
      await client.sendTemplate({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: ACCESS_TOKEN,
        to: RECIPIENT,
        templateName: 'order_update',
        languageCode: 'en_US',
        variables: ['A-1001'],
        header: { format: 'image', media: { mediaId: '9876' } },
      });

      expect(sentBody().template).toMatchObject({
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { id: '9876' } }] },
          { type: 'body', parameters: [{ type: 'text', text: 'A-1001' }] },
        ],
      });
    });

    it('names the document a document header carries', async () => {
      await client.sendTemplate({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: ACCESS_TOKEN,
        to: RECIPIENT,
        templateName: 'invoice_ready',
        languageCode: 'en_US',
        header: { format: 'document', media: { mediaId: '9876' }, fileName: 'invoice.pdf' },
      });

      expect(sentBody().template).toMatchObject({
        components: [
          {
            type: 'header',
            parameters: [{ type: 'document', document: { id: '9876', filename: 'invoice.pdf' } }],
          },
        ],
      });
    });

    it('sends a text header parameter apart from the body ones', async () => {
      await client.sendTemplate({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: ACCESS_TOKEN,
        to: RECIPIENT,
        templateName: 'order_update',
        languageCode: 'en_US',
        variables: ['tomorrow'],
        header: { format: 'text', variables: ['A-1001'] },
      });

      expect(sentBody().template).toMatchObject({
        components: [
          { type: 'header', parameters: [{ type: 'text', text: 'A-1001' }] },
          { type: 'body', parameters: [{ type: 'text', text: 'tomorrow' }] },
        ],
      });
    });

    it('sends location coordinates as strings, which is what Meta documents', async () => {
      await client.sendTemplate({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: ACCESS_TOKEN,
        to: RECIPIENT,
        templateName: 'store_directions',
        languageCode: 'en_US',
        header: { format: 'location', latitude: 24.7136, longitude: 46.6753, name: 'Branch' },
      });

      expect(sentBody().template).toMatchObject({
        components: [
          {
            type: 'header',
            parameters: [
              {
                type: 'location',
                location: { latitude: '24.7136', longitude: '46.6753', name: 'Branch' },
              },
            ],
          },
        ],
      });
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

  describe('media (TAR-20e)', () => {
    const MEDIA_ID = 'meta-media-1234';
    const MEDIA_URL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1';
    const TRANSFER_TIMEOUT_MS = 60_000;

    /** A CDN response: bytes and headers, with no JSON body to parse. */
    function cdnResponds(status: number, body: ReadableStream<Uint8Array> | null) {
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        body,
        json: () => Promise.reject(new Error('the CDN does not answer JSON')),
      };
    }

    function bytes(content: string): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content));
          controller.close();
        },
      });
    }

    describe('describeMedia', () => {
      it('reads the URL and what Meta claims about the bytes', async () => {
        fetchMock.mockResolvedValue(
          metaResponds(200, {
            url: MEDIA_URL,
            mime_type: 'image/jpeg',
            sha256: 'AB12',
            file_size: 4096,
          }),
        );

        await expect(
          client.describeMedia({ providerMediaId: MEDIA_ID, accessToken: ACCESS_TOKEN }),
        ).resolves.toEqual({
          url: MEDIA_URL,
          mimeType: 'image/jpeg',
          // Lower-cased, so a comparison against a computed digest can be exact.
          sha256: 'ab12',
          sizeBytes: 4096,
        });

        expect(callArgs()[0]).toBe(`${BASE_URL}/${VERSION}/${MEDIA_ID}`);
      });

      it('reads a numeric string file size, which older versions send', async () => {
        fetchMock.mockResolvedValue(metaResponds(200, { url: MEDIA_URL, file_size: '4096' }));

        await expect(
          client.describeMedia({ providerMediaId: MEDIA_ID, accessToken: ACCESS_TOKEN }),
        ).resolves.toMatchObject({ sizeBytes: 4096, mimeType: null, sha256: null });
      });

      it('treats a 200 with no URL as transient rather than as an answer', async () => {
        fetchMock.mockResolvedValue(metaResponds(200, { id: MEDIA_ID }));

        await expect(
          client.describeMedia({ providerMediaId: MEDIA_ID, accessToken: ACCESS_TOKEN }),
        ).rejects.toThrow(MetaUnavailableError);
      });
    });

    describe('downloadMedia', () => {
      it('fetches the CDN URL with the bearer token and returns the stream', async () => {
        fetchMock.mockResolvedValue(cdnResponds(200, bytes('a photograph')));

        const body = await client.downloadMedia({
          url: MEDIA_URL,
          accessToken: ACCESS_TOKEN,
          timeoutMs: TRANSFER_TIMEOUT_MS,
        });

        expect(body).not.toBeNull();

        const [url, init] = callArgs();

        expect(url).toBe(MEDIA_URL);
        expect((init.headers as Record<string, string>).authorization).toBe(
          `Bearer ${ACCESS_TOKEN}`,
        );
      });

      it('refuses to follow a redirect, which would be a second unvalidated URL', async () => {
        fetchMock.mockResolvedValue(cdnResponds(200, bytes('x')));

        await client.downloadMedia({
          url: MEDIA_URL,
          accessToken: ACCESS_TOKEN,
          timeoutMs: TRANSFER_TIMEOUT_MS,
        });

        expect(callArgs()[1].redirect).toBe('error');
      });

      it.each([
        ['a host outside Meta', 'https://evil.example.com/whatsapp/media'],
        ['a look-alike host', 'https://evil-fbcdn.net/media'],
        ['the cloud metadata endpoint', 'http://169.254.169.254/latest/meta-data/'],
        ['a plain-text URL', 'http://lookaside.fbsbx.com/media'],
        ['a file URL', 'file:///etc/passwd'],
        ['nonsense', 'not-a-url'],
      ])('refuses %s without making a request', async (_name, url) => {
        // The URL comes from a third party's response and this request carries a
        // bearer token: an unvalidated fetch is a credential-forwarding proxy.
        await expect(
          client.downloadMedia({ url, accessToken: ACCESS_TOKEN, timeoutMs: TRANSFER_TIMEOUT_MS }),
        ).rejects.toThrow(MetaRequestRejectedError);

        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('does not quote the credentialed URL in the failure it logs', async () => {
        await expect(
          client.downloadMedia({
            url: 'https://evil.example.com/x?token=secret',
            accessToken: ACCESS_TOKEN,
            timeoutMs: TRANSFER_TIMEOUT_MS,
          }),
        ).rejects.not.toThrow(/token=secret/);
      });

      it('classifies an expired handle as a rejection, not as something to retry', async () => {
        fetchMock.mockResolvedValue(cdnResponds(404, null));

        await expect(
          client.downloadMedia({
            url: MEDIA_URL,
            accessToken: ACCESS_TOKEN,
            timeoutMs: TRANSFER_TIMEOUT_MS,
          }),
        ).rejects.toThrow(MetaRequestRejectedError);
      });

      it('classifies a CDN outage as transient', async () => {
        fetchMock.mockResolvedValue(cdnResponds(503, null));

        await expect(
          client.downloadMedia({
            url: MEDIA_URL,
            accessToken: ACCESS_TOKEN,
            timeoutMs: TRANSFER_TIMEOUT_MS,
          }),
        ).rejects.toThrow(MetaUnavailableError);
      });

      it('treats a 200 with no body as transient', async () => {
        fetchMock.mockResolvedValue(cdnResponds(200, null));

        await expect(
          client.downloadMedia({
            url: MEDIA_URL,
            accessToken: ACCESS_TOKEN,
            timeoutMs: TRANSFER_TIMEOUT_MS,
          }),
        ).rejects.toThrow(MetaUnavailableError);
      });
    });

    describe('uploadMedia', () => {
      const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' });

      it("posts a multipart body to the phone number and returns Meta's handle", async () => {
        fetchMock.mockResolvedValue(metaResponds(200, { id: MEDIA_ID }));

        await expect(
          client.uploadMedia({
            phoneNumberId: PHONE_NUMBER_ID,
            accessToken: ACCESS_TOKEN,
            file,
            mimeType: 'application/pdf',
            fileName: 'invoice.pdf',
            timeoutMs: TRANSFER_TIMEOUT_MS,
          }),
        ).resolves.toBe(MEDIA_ID);

        const [url, init] = callArgs();

        expect(url).toBe(`${BASE_URL}/${VERSION}/${PHONE_NUMBER_ID}/media`);
        expect(init.body).toBeInstanceOf(FormData);

        const form = init.body as FormData;

        expect(form.get('messaging_product')).toBe('whatsapp');
        expect(form.get('type')).toBe('application/pdf');
        // `FormData` sets its own content-type with the boundary; naming one by
        // hand omits the boundary and Meta rejects the body.
        expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
      });

      it('treats a successful response with no id as transient', async () => {
        fetchMock.mockResolvedValue(metaResponds(200, {}));

        await expect(
          client.uploadMedia({
            phoneNumberId: PHONE_NUMBER_ID,
            accessToken: ACCESS_TOKEN,
            file,
            mimeType: 'application/pdf',
            fileName: 'invoice.pdf',
            timeoutMs: TRANSFER_TIMEOUT_MS,
          }),
        ).rejects.toThrow(MetaUnavailableError);
      });
    });
  });
});
