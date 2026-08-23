import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
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

const APP_ID = '1234567890123456';
const APP_SECRET = 'a-meta-app-secret';

/**
 * The two axes a signup test varies: whether the app id and the app secret are
 * configured. `getOrThrow` covers the values every call needs; `get` covers the
 * two that are optional in the env schema and fail closed here.
 */
function configWith(optional: Record<string, string | undefined>): ConfigService {
  const required: Record<string, string | number> = {
    META_GRAPH_API_BASE_URL: BASE_URL,
    META_GRAPH_API_VERSION: VERSION,
    META_GRAPH_API_TIMEOUT_MS: TIMEOUT_MS,
  };

  return {
    getOrThrow: (name: string) => required[name],
    get: (name: string) => optional[name],
  } as unknown as ConfigService;
}

const CONFIG = configWith({ META_APP_ID: APP_ID, WHATSAPP_APP_SECRET: APP_SECRET });

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

  describe('embedded signup (TAR-167)', () => {
    const CODE = 'AQBx-an-exchangeable-token-code';
    const BUSINESS_TOKEN = 'EAAJc-a-business-integration-token';

    /** The proof Meta expects: HMAC-SHA256 of the token under the app secret. */
    const PROOF = createHmac('sha256', APP_SECRET).update(BUSINESS_TOKEN).digest('hex');

    /** The query string of the single request the client made. */
    function sentQuery(): URLSearchParams {
      return new URL(callArgs()[0]).searchParams;
    }

    describe('exchangeSignupCode', () => {
      it('trades the code for the business token, as the app rather than as a tenant', async () => {
        fetchMock.mockResolvedValue(
          metaResponds(200, { access_token: BUSINESS_TOKEN, token_type: 'bearer' }),
        );

        await expect(client.exchangeSignupCode({ code: CODE })).resolves.toEqual({
          accessToken: BUSINESS_TOKEN,
          // Meta's documented response for this flow carries no `expires_in`,
          // and the schema has no `token_expires_at` to put one in.
          expiresInSeconds: null,
        });

        const [url, init] = callArgs();
        const query = sentQuery();

        expect(url.startsWith(`${BASE_URL}/${VERSION}/oauth/access_token?`)).toBe(true);
        expect(init.method).toBe('GET');
        expect(query.get('client_id')).toBe(APP_ID);
        expect(query.get('client_secret')).toBe(APP_SECRET);
        expect(query.get('code')).toBe(CODE);
      });

      it('sends no redirect_uri, because the JS SDK flow never had one', async () => {
        // Meta rejects a `redirect_uri` it never issued the code against, which
        // would fail every signup in a way that reads like a bad code.
        fetchMock.mockResolvedValue(metaResponds(200, { access_token: BUSINESS_TOKEN }));

        await client.exchangeSignupCode({ code: CODE });

        expect(sentQuery().has('redirect_uri')).toBe(false);
      });

      it('carries no bearer header, because there is no token yet', async () => {
        fetchMock.mockResolvedValue(metaResponds(200, { access_token: BUSINESS_TOKEN }));

        await client.exchangeSignupCode({ code: CODE });

        expect(callArgs()[1].headers).not.toHaveProperty('authorization');
      });

      it('surfaces an expiry Meta sends, rather than discarding it', async () => {
        // The send path assumes a credential that keeps working. A non-null
        // value here is the signal that assumption has stopped holding.
        fetchMock.mockResolvedValue(
          metaResponds(200, { access_token: BUSINESS_TOKEN, expires_in: 5_183_814 }),
        );

        await expect(client.exchangeSignupCode({ code: CODE })).resolves.toMatchObject({
          expiresInSeconds: 5_183_814,
        });
      });

      it.each([
        ['a spent code', 36009, 'This authorization code has been used.'],
        ['an expired code', 36007, 'This authorization code has expired.'],
      ])('reports %s as a rejection, so nothing retries it', async (_name, subcode, message) => {
        // The code is single-use and lives 30 seconds. Classifying either as
        // transient would retry a credential that cannot come back.
        fetchMock.mockResolvedValue(
          metaResponds(400, {
            error: { message, type: 'OAuthException', code: 100, error_subcode: subcode },
          }),
        );

        const error = await client
          .exchangeSignupCode({ code: CODE })
          .catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(MetaRequestRejectedError);
        expect((error as MetaRequestRejectedError).detail?.subcode).toBe(subcode);
      });

      it('reports a missing permission as an authentication failure', async () => {
        fetchMock.mockResolvedValue(
          metaResponds(400, {
            error: {
              message: '(#200) Requires whatsapp_business_management permission',
              type: 'OAuthException',
              code: 200,
            },
          }),
        );

        await expect(client.exchangeSignupCode({ code: CODE })).rejects.toBeInstanceOf(
          MetaAuthenticationError,
        );
      });

      it('reports Meta throttling the app as rate limited', async () => {
        fetchMock.mockResolvedValue(
          metaResponds(400, { error: { message: 'Application request limit reached', code: 4 } }),
        );

        await expect(client.exchangeSignupCode({ code: CODE })).rejects.toBeInstanceOf(
          MetaRateLimitedError,
        );
      });

      it('reports a Meta outage as transient', async () => {
        fetchMock.mockResolvedValue(metaResponds(500, null));

        await expect(client.exchangeSignupCode({ code: CODE })).rejects.toBeInstanceOf(
          MetaUnavailableError,
        );
      });

      it('treats a 200 with no token as an answer it cannot act on', async () => {
        fetchMock.mockResolvedValue(metaResponds(200, { token_type: 'bearer' }));

        await expect(client.exchangeSignupCode({ code: CODE })).rejects.toBeInstanceOf(
          MetaUnavailableError,
        );
      });

      it.each(['META_APP_ID', 'WHATSAPP_APP_SECRET'])(
        'fails closed when %s is absent, rather than calling Meta without it',
        async (missing) => {
          // `client_id=undefined` reaches Meta as a rejection that reads like a
          // bad code, sending the tenant round a 30-second flow again for a
          // configuration problem only an operator can fix.
          const configured: Record<string, string | undefined> = {
            META_APP_ID: APP_ID,
            WHATSAPP_APP_SECRET: APP_SECRET,
            [missing]: undefined,
          };

          const unconfigured = new MetaCloudApiClient(configWith(configured));
          const error = await unconfigured
            .exchangeSignupCode({ code: CODE })
            .catch((thrown: unknown) => thrown);

          expect(error).toBeInstanceOf(MetaRequestRejectedError);
          // `status` 0 says the client refused, not Meta.
          expect((error as MetaRequestRejectedError).status).toBe(0);
          expect((error as MetaRequestRejectedError).message).toContain(missing);
          expect(fetchMock).not.toHaveBeenCalled();
        },
      );

      it('never puts the secret or the code in the line it logs', async () => {
        const logged = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        fetchMock.mockResolvedValue(
          metaResponds(400, { error: { message: 'nope', code: 100, fbtrace_id: 'Az8...' } }),
        );

        const error = await client
          .exchangeSignupCode({ code: CODE })
          .catch((thrown: unknown) => thrown);

        const line = String(logged.mock.calls[0]?.[0]);

        expect(line).toContain('oauth/access_token');
        expect(line).not.toContain(APP_SECRET);
        expect(line).not.toContain(CODE);
        expect(JSON.stringify(error)).not.toContain(APP_SECRET);
        expect(JSON.stringify(error)).not.toContain(CODE);

        logged.mockRestore();
      });
    });

    describe('describeBusinessAccount', () => {
      it('reads the WABA back with the token just issued for it', async () => {
        fetchMock.mockResolvedValue(
          metaResponds(200, {
            id: WABA_ID,
            name: "Jasper's Market",
            business_verification_status: 'verified',
          }),
        );

        await expect(
          client.describeBusinessAccount({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ).resolves.toEqual({
          // Meta's own answer, so the caller compares rather than trusts the
          // `wabaId` the browser claimed.
          wabaId: WABA_ID,
          name: "Jasper's Market",
          verificationStatus: 'verified',
        });

        const [url, init] = callArgs();

        expect(url.startsWith(`${BASE_URL}/${VERSION}/${WABA_ID}?`)).toBe(true);
        expect(init.headers).toMatchObject({ authorization: `Bearer ${BUSINESS_TOKEN}` });
        expect(sentQuery().get('fields')).toBe('id,name,business_verification_status');
      });

      it.each([
        ['pending_submission', 'pending'],
        ['pending_need_more_info', 'pending'],
        ['not_verified', 'not_verified'],
        ['rejected', 'rejected'],
      ])('maps Meta\'s "%s" onto the published vocabulary', async (metaStatus, expected) => {
        fetchMock.mockResolvedValue(
          metaResponds(200, { id: WABA_ID, business_verification_status: metaStatus }),
        );

        await expect(
          client.describeBusinessAccount({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ).resolves.toMatchObject({ verificationStatus: expected });
      });

      it('reports a verification state it does not model as null rather than guessing', async () => {
        // `expired` and `revoked` are neither verified nor rejected, and a wrong
        // badge in front of an operator is worse than an absent one.
        fetchMock.mockResolvedValue(
          metaResponds(200, { id: WABA_ID, business_verification_status: 'revoked' }),
        );

        await expect(
          client.describeBusinessAccount({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ).resolves.toMatchObject({ verificationStatus: null, name: null });
      });

      it('reports a token that cannot see the WABA as an authentication failure', async () => {
        // This is the check that stops a browser claiming a WABA its token does
        // not cover; the caller turns it into `waba_mismatch`.
        fetchMock.mockResolvedValue(
          metaResponds(400, { error: { message: 'Invalid OAuth access token', code: 190 } }),
        );

        await expect(
          client.describeBusinessAccount({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ).rejects.toBeInstanceOf(MetaAuthenticationError);
      });

      it('reports a WABA the token may not read as a rejection', async () => {
        fetchMock.mockResolvedValue(
          metaResponds(400, {
            error: { message: 'Unsupported get request.', code: 100, error_subcode: 33 },
          }),
        );

        await expect(
          client.describeBusinessAccount({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ).rejects.toBeInstanceOf(MetaRequestRejectedError);
      });

      it('treats a 200 with no id as transient', async () => {
        fetchMock.mockResolvedValue(metaResponds(200, { name: 'nameless' }));

        await expect(
          client.describeBusinessAccount({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ).rejects.toBeInstanceOf(MetaUnavailableError);
      });
    });

    describe('listPhoneNumbers', () => {
      it('hydrates the numbers from Meta, not from the browser', async () => {
        fetchMock.mockResolvedValue(
          metaResponds(200, {
            data: [
              {
                id: PHONE_NUMBER_ID,
                display_phone_number: '+966 50 123 4567',
                verified_name: "Jasper's Market",
                quality_rating: 'GREEN',
              },
            ],
            paging: { cursors: { after: 'LAST' } },
          }),
        );

        await expect(
          client.listPhoneNumbers({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ).resolves.toEqual({
          phoneNumbers: [
            {
              phoneNumberId: PHONE_NUMBER_ID,
              displayPhoneNumber: '+966 50 123 4567',
              verifiedName: "Jasper's Market",
              qualityRating: 'green',
            },
          ],
          // Meta sends `cursors.after` on the final page too; only `paging.next`
          // means there is more.
          hasMore: false,
        });

        expect(callArgs()[0].startsWith(`${BASE_URL}/${VERSION}/${WABA_ID}/phone_numbers?`)).toBe(
          true,
        );
        expect(sentQuery().get('fields')).toBe(
          'id,display_phone_number,verified_name,quality_rating',
        );
      });

      it('reports a WABA with more numbers than one page, rather than truncating silently', async () => {
        fetchMock.mockResolvedValue(
          metaResponds(200, {
            data: [{ id: PHONE_NUMBER_ID, display_phone_number: '+966 50 123 4567' }],
            paging: { next: 'https://graph.test/next' },
          }),
        );

        await expect(
          client.listPhoneNumbers({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ).resolves.toMatchObject({ hasMore: true });
      });

      it("reads Meta's own 'not rated yet' values as unknown, and anything else as null", async () => {
        fetchMock.mockResolvedValue(
          metaResponds(200, {
            data: [
              { id: '1', display_phone_number: '+1', quality_rating: 'NA' },
              { id: '2', display_phone_number: '+2', quality_rating: 'PLATINUM' },
              { id: '3', display_phone_number: '+3' },
            ],
            paging: {},
          }),
        );

        const page = await client.listPhoneNumbers({
          wabaId: WABA_ID,
          accessToken: BUSINESS_TOKEN,
        });

        expect(page.phoneNumbers.map((number) => number.qualityRating)).toEqual([
          'unknown',
          null,
          null,
        ]);
      });

      it('drops a number with no id or no display number, which the connection could not accept', async () => {
        fetchMock.mockResolvedValue(
          metaResponds(200, {
            data: [{ display_phone_number: '+1' }, { id: '2' }, null, 'nonsense'],
            paging: {},
          }),
        );

        await expect(
          client.listPhoneNumbers({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ).resolves.toMatchObject({ phoneNumbers: [] });
      });

      it('reports Meta throttling as rate limited, with the wait it asked for', async () => {
        fetchMock.mockResolvedValue(
          metaResponds(429, { error: { message: 'Too many calls' } }, { 'retry-after': '12' }),
        );

        const error = await client
          .listPhoneNumbers({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN })
          .catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(MetaRateLimitedError);
        expect((error as MetaRateLimitedError).retryAfterSeconds).toBe(12);
      });

      it('reports a Meta outage as transient', async () => {
        fetchMock.mockResolvedValue(metaResponds(503, null));

        await expect(
          client.listPhoneNumbers({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ).rejects.toBeInstanceOf(MetaUnavailableError);
      });
    });

    describe('subscribeApp', () => {
      it("posts to the WABA's subscribed_apps edge with the business token", async () => {
        fetchMock.mockResolvedValue(metaResponds(200, { success: true }));

        await expect(
          client.subscribeApp({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ).resolves.toBeUndefined();

        const [url, init] = callArgs();

        expect(url.startsWith(`${BASE_URL}/${VERSION}/${WABA_ID}/subscribed_apps`)).toBe(true);
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({ authorization: `Bearer ${BUSINESS_TOKEN}` });
      });

      it('refuses to claim a subscription Meta did not acknowledge', async () => {
        // A connected WABA with no subscription looks healthy and receives
        // nothing; reporting success here is how an inbox stays silent.
        fetchMock.mockResolvedValue(metaResponds(200, { success: false }));

        await expect(
          client.subscribeApp({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ).rejects.toBeInstanceOf(MetaUnavailableError);
      });

      it('reports a missing permission as an authentication failure', async () => {
        fetchMock.mockResolvedValue(
          metaResponds(403, {
            error: {
              message: '(#200) Requires whatsapp_business_management permission',
              code: 200,
            },
          }),
        );

        await expect(
          client.subscribeApp({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ).rejects.toBeInstanceOf(MetaAuthenticationError);
      });
    });

    describe('registerPhoneNumber', () => {
      const REGISTER = {
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: BUSINESS_TOKEN,
        pin: '000042',
      };

      it("posts to the number's register edge with the messaging product and the PIN", async () => {
        fetchMock.mockResolvedValue(metaResponds(200, { success: true }));

        await expect(client.registerPhoneNumber(REGISTER)).resolves.toBeUndefined();

        const [url, init] = callArgs();

        expect(url.startsWith(`${BASE_URL}/${VERSION}/${PHONE_NUMBER_ID}/register`)).toBe(true);
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({ authorization: `Bearer ${BUSINESS_TOKEN}` });
        expect(JSON.parse(init.body as string)).toEqual({
          messaging_product: 'whatsapp',
          // Leading zeros are significant, and a number type would make this 42.
          pin: '000042',
        });
      });

      it('keeps the PIN out of the query string, which is what a failure logs', async () => {
        fetchMock.mockResolvedValue(metaResponds(200, { success: true }));

        await client.registerPhoneNumber(REGISTER);

        const [url] = callArgs();

        expect(url).not.toContain('000042');
      });

      it('refuses to claim a registration Meta did not acknowledge', async () => {
        // A number reported as registered that Meta did not accept is a number
        // whose every send will fail, recorded as if it could send.
        fetchMock.mockResolvedValue(metaResponds(200, { success: false }));

        await expect(client.registerPhoneNumber(REGISTER)).rejects.toBeInstanceOf(
          MetaUnavailableError,
        );
      });

      it('leaves a refusal as a rejection for the caller to interpret', async () => {
        // The client is a transport: what "Meta refused this number" means for
        // the row is the registration service's decision, not this one's.
        fetchMock.mockResolvedValue(
          metaResponds(400, {
            error: { message: 'Phone number already registered', code: 133_016 },
          }),
        );

        await expect(client.registerPhoneNumber(REGISTER)).rejects.toBeInstanceOf(
          MetaRequestRejectedError,
        );
      });

      it('reports a rejected token as an authentication failure', async () => {
        fetchMock.mockResolvedValue(
          metaResponds(401, { error: { message: 'Invalid OAuth access token', code: 190 } }),
        );

        await expect(client.registerPhoneNumber(REGISTER)).rejects.toBeInstanceOf(
          MetaAuthenticationError,
        );
      });
    });

    describe('appsecret_proof', () => {
      it.each([
        [
          'describeBusinessAccount',
          () => client.describeBusinessAccount({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ],
        [
          'listPhoneNumbers',
          () => client.listPhoneNumbers({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ],
        [
          'subscribeApp',
          () => client.subscribeApp({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN }),
        ],
        [
          'registerPhoneNumber',
          () =>
            client.registerPhoneNumber({
              phoneNumberId: PHONE_NUMBER_ID,
              accessToken: BUSINESS_TOKEN,
              pin: '000042',
            }),
        ],
      ])('proves the app secret on %s, which Meta may require', async (_name, call) => {
        // Meta accepts the proof whether or not "Require App Secret" is on, and
        // requires it when it is — so sending it always is the answer that
        // cannot be wrong.
        fetchMock.mockResolvedValue(metaResponds(200, { id: WABA_ID, data: [], success: true }));

        await call();

        expect(sentQuery().get('appsecret_proof')).toBe(PROOF);
      });

      it('omits the proof when no app secret is configured, rather than sending a wrong one', async () => {
        const unconfigured = new MetaCloudApiClient(configWith({ META_APP_ID: APP_ID }));

        fetchMock.mockResolvedValue(metaResponds(200, { id: WABA_ID }));

        await unconfigured.describeBusinessAccount({
          wabaId: WABA_ID,
          accessToken: BUSINESS_TOKEN,
        });

        expect(sentQuery().has('appsecret_proof')).toBe(false);
      });

      it('never puts the business token in the proof it sends', async () => {
        fetchMock.mockResolvedValue(metaResponds(200, { id: WABA_ID }));

        await client.describeBusinessAccount({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN });

        expect(callArgs()[0]).not.toContain(BUSINESS_TOKEN);
      });
    });
  });
});
