import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  MessageTemplateStatus,
  WhatsAppBusinessVerificationStatus,
  WhatsAppQualityRating,
} from '@whatsappcrm/contracts';
import {
  MetaAuthenticationError,
  MetaRateLimitedError,
  MetaRequestRejectedError,
  MetaUnavailableError,
  type MetaErrorDetail,
} from './meta-cloud-api.errors';

/**
 * Meta's numeric codes that mean "the credential is not acceptable", regardless
 * of the HTTP status they arrive with — Meta answers 400 for an expired token
 * often enough that status alone misclassifies it as a permanent rejection.
 */
const AUTHENTICATION_CODES = new Set([0, 3, 10, 190, 200, 299]);

/**
 * Meta's throttling codes. `4` is the app-level limit, `80007` the business
 * account limit, `130429` the per-number message throughput cap, and `131048`
 * the spam-rate limit. All four mean "later", not "no".
 */
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048]);

/** Meta's own "try again" codes, which arrive with a 400-range or 500-range status. */
const TRANSIENT_CODES = new Set([1, 2, 131000]);

/** Meta's page size cap for `message_templates`. Asking for more is an error, not a truncation. */
const TEMPLATE_PAGE_SIZE = 100;

/**
 * How many of a WABA's numbers one `listPhoneNumbers` call asks for.
 *
 * Matched to `ConnectWhatsAppBusinessAccountInputSchema`'s own ceiling of 20:
 * asking for more would return numbers the connection cannot accept anyway.
 * Meta reporting a further page is carried back as `hasMore` rather than
 * dropped, so a WABA larger than this is a fact the caller can report instead of
 * a silent truncation.
 */
const PHONE_NUMBER_PAGE_SIZE = 20;

/**
 * Meta's business-verification vocabulary, mapped onto the four states
 * `WhatsAppBusinessVerificationStatusSchema` publishes.
 *
 * `business_verification_status` on the WABA node is the field this reads —
 * "current status of business verification of the Meta Business Account which
 * owns this WhatsApp Business Account" — and not `account_review_status`, which
 * is Meta's review of the WABA itself and a different question. 0002's contract
 * left the choice between the two open pending this verification (TAR-167).
 *
 * Meta's `pending_submission` and `pending_need_more_info` are both waiting on
 * the business, so both read as `pending`. Anything else — `expired`, `revoked`,
 * `failed`, or a value Meta adds tomorrow — maps to `null` on the same reasoning
 * as `TEMPLATE_STATUSES`: guessing `verified` or `rejected` for a state this
 * build does not model would put a wrong badge in front of an operator.
 */
const BUSINESS_VERIFICATION_STATUSES: Readonly<Record<string, WhatsAppBusinessVerificationStatus>> =
  {
    verified: 'verified',
    not_verified: 'not_verified',
    pending: 'pending',
    pending_submission: 'pending',
    pending_need_more_info: 'pending',
    rejected: 'rejected',
  };

/**
 * Meta's per-number quality rating. `UNKNOWN` and `NA` are both Meta's own way
 * of saying it has not rated the number, and the contract models that as
 * `unknown`; a rating this build does not know is `null`, which the contract
 * distinguishes as "we have not read one".
 */
const QUALITY_RATINGS: Readonly<Record<string, WhatsAppQualityRating>> = {
  GREEN: 'green',
  YELLOW: 'yellow',
  RED: 'red',
  UNKNOWN: 'unknown',
  NA: 'unknown',
};

/**
 * Meta's template statuses, mapped onto ours. Anything absent — `IN_APPEAL`,
 * `PENDING_DELETION`, `DELETED`, or a value Meta adds tomorrow — is reported as
 * skipped by the sync rather than guessed at, because guessing `approved` for an
 * unknown status would put an unsendable template in front of an agent.
 */
const TEMPLATE_STATUSES: Readonly<Record<string, MessageTemplateStatus>> = {
  APPROVED: 'approved',
  PENDING: 'pending',
  REJECTED: 'rejected',
  PAUSED: 'paused',
  DISABLED: 'disabled',
};

export interface SendTextCommand {
  phoneNumberId: string;
  accessToken: string;
  /** E.164, as Meta wants it. */
  to: string;
  body: string;
  /** Whether Meta may render a preview card for a URL in the body. */
  previewUrl?: boolean;
}

/**
 * Media is addressed either by a URL Meta will fetch, or by a media id Meta
 * already holds. A union rather than two optional fields, so "neither" and
 * "both" are unrepresentable instead of being validated for.
 */
export type MediaReference = { link: string } | { mediaId: string };

export interface SendMediaCommand {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  kind: 'image' | 'video' | 'audio' | 'document';
  media: MediaReference;
  /** Ignored by Meta for `audio`, which has nowhere to render one. */
  caption?: string;
  /** `document` only; what the recipient sees as the file name. */
  fileName?: string;
}

/**
 * What the template's header needs, when it has one. Mirrors
 * `SendTemplateHeaderSchema` (0002, amendment 1) with the media reference this
 * client already speaks in, because a header image may be a Meta media id or a
 * link exactly as a media message's may.
 *
 * Whether a header is required at all, and whether its format matches the
 * approved template's, is checked by the send handler that holds the template
 * row (TAR-68). This client is a transport: it maps what it is given.
 */
export type TemplateHeader =
  | { format: 'text'; variables: readonly string[] }
  | { format: 'image' | 'video' | 'document'; media: MediaReference; fileName?: string }
  | {
      format: 'location';
      latitude: number;
      longitude: number;
      name?: string;
      address?: string;
    };

export interface SendTemplateCommand {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  templateName: string;
  /** Meta's language tag for the template, e.g. `en_US` — its format, not BCP 47. */
  languageCode: string;
  /** Positional body substitutions, in the order the approved template declares them. */
  variables?: readonly string[];
  /** Required by Meta exactly when the approved template declares a header. */
  header?: TemplateHeader;
}

export interface SentMessage {
  /** Meta's `wamid…`. The idempotency key every later status webhook is matched on. */
  providerMessageId: string;
}

export interface MetaMessageTemplate {
  name: string;
  language: string;
  category: string | null;
  /** `null` when Meta reported a status this build does not model. */
  status: MessageTemplateStatus | null;
  components: unknown;
  providerTemplateId: string | null;
}

export interface MetaMessageTemplatePage {
  templates: MetaMessageTemplate[];
  /** Cursor for the next page, or `null` at the end. */
  nextAfter: string | null;
}

export interface ListMessageTemplatesCommand {
  wabaId: string;
  accessToken: string;
  after?: string;
}

export interface DescribeMediaCommand {
  /** Meta's media handle, as an inbound message payload carries it. */
  providerMediaId: string;
  accessToken: string;
}

/**
 * Where Meta is holding one media object, and what it claims to be.
 *
 * Everything here is Meta's assertion, not a fact about the bytes. `sizeBytes`
 * and `sha256` are worth having — the digest lets a download be verified rather
 * than trusted — but the caller measures what it actually receives and stores
 * that.
 */
export interface MetaMediaDescriptor {
  /**
   * A short-lived URL on Meta's CDN. **Expires five minutes after it is
   * issued**, and requires the same bearer token to fetch, which is why it is
   * never stored and never handed to a client.
   */
  url: string;
  mimeType: string | null;
  sizeBytes: number | null;
  /** Lower-case hex, as Meta publishes it. Null when Meta omitted it. */
  sha256: string | null;
}

export interface DownloadMediaCommand {
  /** The URL from `describeMedia`, unmodified. */
  url: string;
  accessToken: string;
  timeoutMs: number;
}

export interface UploadMediaCommand {
  phoneNumberId: string;
  accessToken: string;
  /** The bytes, and the media type Meta should record them under. */
  file: Blob;
  mimeType: string;
  /** What Meta names the part. Cosmetic to Meta, useful in its own logs. */
  fileName: string;
  /** Sized for a transfer, not for a JSON round trip. */
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Embedded Signup (TAR-167, 0002 amendment 2)
// ---------------------------------------------------------------------------

export interface ExchangeSignupCodeCommand {
  /**
   * Meta's exchangeable token code, straight from the browser's `FINISH` event.
   * Single-use, and alive for about 30 seconds — the reason nothing in this
   * flow may be queued or retried.
   */
  code: string;
}

/**
 * The business integration system user access token Meta issues for the
 * customer's WABA, and what Meta says about its life.
 *
 * `expiresInSeconds` is read defensively and is `null` on the response Meta's
 * Tech Provider flow documents, which carries `access_token` and `token_type`
 * and no `expires_in`. It is surfaced rather than discarded because
 * `whatsapp_business_accounts` has no `token_expires_at` and the send path
 * assumes a credential that keeps working: a non-null value here is the signal
 * that assumption has stopped holding, and it is the caller's to act on.
 */
export interface ExchangedBusinessToken {
  accessToken: string;
  expiresInSeconds: number | null;
}

export interface DescribeBusinessAccountCommand {
  wabaId: string;
  accessToken: string;
}

/**
 * What Meta says the WABA is, read back with the token that was just issued for
 * it. `wabaId` is Meta's own answer rather than the one that was asked for, so
 * the caller can compare the two instead of trusting the browser's claim.
 */
export interface MetaBusinessAccount {
  wabaId: string;
  name: string | null;
  /** `null` when Meta reported a verification state this build does not model. */
  verificationStatus: WhatsAppBusinessVerificationStatus | null;
}

export interface ListPhoneNumbersCommand {
  wabaId: string;
  accessToken: string;
}

/** One of the WABA's business phone numbers, as Meta describes it. */
export interface MetaPhoneNumber {
  phoneNumberId: string;
  /** Meta's formatted display form, e.g. `+966 50 123 4567`. Not E.164. */
  displayPhoneNumber: string;
  verifiedName: string | null;
  /** `null` when Meta reported a rating this build does not model. */
  qualityRating: WhatsAppQualityRating | null;
}

export interface MetaPhoneNumberPage {
  phoneNumbers: MetaPhoneNumber[];
  /** True when the WABA holds more numbers than `PHONE_NUMBER_PAGE_SIZE` returned. */
  hasMore: boolean;
}

export interface SubscribeAppCommand {
  wabaId: string;
  accessToken: string;
}

export interface RegisterPhoneNumberCommand {
  phoneNumberId: string;
  accessToken: string;
  /**
   * Six digits as a **string**: leading zeros are significant, and `000042` in a
   * number type would silently become `42` and be refused by Meta.
   */
  pin: string;
}

/**
 * Meta's CDN hosts that a media URL may point at.
 *
 * The URL in a `describeMedia` response is a value from a third party that this
 * process then fetches, which is the definition of an SSRF sink (TAR-39,
 * security: "any URL that originates from user input goes through an
 * allowlist"). Meta is not an attacker, but Meta's response is reachable by
 * anyone who can make this process call `describeMedia` with a handle of their
 * choosing, and the request carries a bearer token — so an unvalidated fetch
 * would be a credential-forwarding proxy pointed at whatever host the response
 * named, including the metadata endpoint of whatever cloud this runs in.
 *
 * Matched on the registered domain, so a per-region or per-shard subdomain is
 * covered without listing them, and `evil-fbcdn.net` is not.
 */
const MEDIA_HOST_SUFFIXES = ['.fbcdn.net', '.facebook.com', '.fbsbx.com', '.whatsapp.net'] as const;

/** What varies between one Graph API round trip and the next. See `request`. */
interface GraphRequestOptions {
  /** Omitted only by `exchangeSignupCode`, which authenticates as the app. */
  accessToken?: string;
  /** Kept apart from the path, which is what a failure logs. */
  query?: URLSearchParams;
  /** Overrides `META_GRAPH_API_TIMEOUT_MS`. Used only by the media upload. */
  timeoutMs?: number;
}

/**
 * The only place in this codebase that speaks to Meta's Graph API.
 *
 * ## What it is, and what it is not
 *
 * It is a transport. It takes a phone number id or a WABA id, an access token,
 * and the facts of one call; it returns Meta's answer or throws one of four
 * typed errors. It holds no state between calls, reads no database, and knows
 * nothing about tenants — which is what makes it **idempotent-safe at the caller
 * boundary**: calling it twice with the same command produces exactly two Meta
 * calls, and deciding whether that should have happened belongs to the caller.
 * `Idempotency-Key` handling is TAR-20c's, one layer up, where the request and
 * its stored response live.
 *
 * Credentials are passed in per call rather than resolved here. That is not
 * ceremony: the token is per tenant and per WABA, so a client that looked one up
 * would need tenant context and would become the second place tokens are
 * decrypted. `WhatsAppCredentialResolver` is the first and only one.
 *
 * ## Failure handling
 *
 * Every call has a timeout — an unbounded wait on Meta becomes an unbounded wait
 * on the worker holding it. Nothing is retried in here: retry policy belongs to
 * the queue that owns the job's attempt count and backoff, and a retry loop
 * hidden inside a client multiplies every outer retry by its own.
 *
 * Nothing logs a token, a request body, or a message body. The log line carries
 * the endpoint, the status, and Meta's trace id, which is what a conversation
 * with Meta is conducted in.
 */
@Injectable()
export class MetaCloudApiClient {
  private readonly logger = new Logger(MetaCloudApiClient.name);

  constructor(private readonly config: ConfigService) {}

  async sendText(command: SendTextCommand): Promise<SentMessage> {
    return this.send(command.phoneNumberId, command.accessToken, {
      ...recipient(command.to),
      type: 'text',
      text: { body: command.body, preview_url: command.previewUrl ?? false },
    });
  }

  async sendMedia(command: SendMediaCommand): Promise<SentMessage> {
    return this.send(command.phoneNumberId, command.accessToken, {
      ...recipient(command.to),
      type: command.kind,
      [command.kind]: {
        ...('link' in command.media ? { link: command.media.link } : { id: command.media.mediaId }),
        ...(command.caption === undefined ? {} : { caption: command.caption }),
        // `filename` is Meta's spelling on the wire; see the note on the header
        // mapper below, which crosses the same boundary.
        ...(command.fileName === undefined ? {} : { filename: command.fileName }),
      },
    });
  }

  async sendTemplate(command: SendTemplateCommand): Promise<SentMessage> {
    const variables = command.variables ?? [];
    const components = [
      ...(command.header === undefined ? [] : [headerComponent(command.header)]),
      ...(variables.length === 0
        ? []
        : [{ type: 'body', parameters: variables.map((text) => ({ type: 'text', text })) }]),
    ];

    return this.send(command.phoneNumberId, command.accessToken, {
      ...recipient(command.to),
      type: 'template',
      template: {
        name: command.templateName,
        language: { code: command.languageCode },
        // Omitted entirely when there is nothing to substitute: Meta rejects an
        // empty `components` array on a template with no placeholders.
        ...(components.length === 0 ? {} : { components }),
      },
    });
  }

  /**
   * One page of a WABA's templates. Paging is the caller's loop rather than an
   * internal `while`, so a sync can be bounded, resumed and reported on per page
   * instead of accumulating an unknown number of templates in memory.
   */
  async listMessageTemplates(
    command: ListMessageTemplatesCommand,
  ): Promise<MetaMessageTemplatePage> {
    const payload = await this.request(
      `${command.wabaId}/message_templates`,
      { method: 'GET' },
      {
        accessToken: command.accessToken,
        query: new URLSearchParams({
          fields: 'id,name,language,category,status,components',
          limit: String(TEMPLATE_PAGE_SIZE),
          ...(command.after === undefined ? {} : { after: command.after }),
        }),
      },
    );

    return readTemplatePage(payload);
  }

  /**
   * Where Meta is holding one inbound media object.
   *
   * Two calls rather than one, because that is Meta's shape: a message names a
   * handle, the handle resolves to a URL, and the URL is good for five minutes.
   * Splitting them here rather than hiding both behind a `downloadMedia(id)`
   * keeps the timeouts honest — this one is a small JSON round trip bounded by
   * `META_GRAPH_API_TIMEOUT_MS`, and the transfer below is bounded by its own,
   * much larger, caller-supplied value.
   */
  async describeMedia(command: DescribeMediaCommand): Promise<MetaMediaDescriptor> {
    const payload = await this.request(
      `${command.providerMediaId}`,
      { method: 'GET' },
      {
        accessToken: command.accessToken,
      },
    );

    const descriptor = readMediaDescriptor(payload);

    if (descriptor === null) {
      // A 200 with no URL is a media object Meta acknowledges and will not
      // serve. Transient rather than rejected: the handle may resolve on a
      // later attempt, and within Meta's five-minute window it is worth one.
      throw new MetaUnavailableError(200, null, 'no media url in a successful response');
    }

    return descriptor;
  }

  /**
   * Streams the bytes of one media object.
   *
   * Returns the body rather than a buffer: a document may be 100 MB, and this
   * runs in a queue worker that also has other jobs. The caller pipes it
   * straight into storage, counting and hashing on the way past.
   *
   * The URL is checked against `MEDIA_HOST_SUFFIXES` before the request and
   * redirects are refused outright — a 3xx from the CDN would be a second,
   * unvalidated URL, which is exactly the check being made here. Meta does not
   * redirect these; if it starts, this fails loudly rather than following.
   */
  async downloadMedia(command: DownloadMediaCommand): Promise<ReadableStream<Uint8Array>> {
    assertMetaMediaUrl(command.url);

    const response = await fetch(command.url, {
      method: 'GET',
      headers: { authorization: `Bearer ${command.accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(command.timeoutMs),
    }).catch((error: unknown) => {
      // The URL is not put in the message: it is a credentialed CDN link, and a
      // log line is not the place for one.
      throw new MetaUnavailableError(0, null, describeTransportFailure(error));
    });

    if (!response.ok) {
      // No JSON body to classify — the CDN answers with bytes or with an error
      // page — so this goes through the same classifier with a null payload,
      // which maps on status alone. A 404 here is an expired handle: rejected,
      // not retried, because five minutes do not come back.
      throw this.classify(response.status, response.headers.get('retry-after'), null, 'media');
    }

    if (response.body === null) {
      throw new MetaUnavailableError(response.status, null, 'media response had no body');
    }

    return response.body;
  }

  /**
   * Uploads bytes to a phone number and returns Meta's handle for them.
   *
   * The handle is scoped to that number and expires on Meta's schedule, which
   * is why nothing caches it: a stored handle is a per-number, time-limited
   * cache whose staleness surfaces as a failed send to a customer. Callers
   * upload per send.
   *
   * `FormData` sets its own `content-type` with the boundary, so this is the
   * one request that does not name one — setting it by hand omits the boundary
   * and Meta rejects the body.
   */
  async uploadMedia(command: UploadMediaCommand): Promise<string> {
    const form = new FormData();

    form.set('messaging_product', 'whatsapp');
    form.set('type', command.mimeType);
    form.set('file', command.file, command.fileName);

    const payload = await this.request(
      `${command.phoneNumberId}/media`,
      { method: 'POST', body: form },
      { accessToken: command.accessToken, timeoutMs: command.timeoutMs },
    );

    const id = asRecord(payload)?.id;

    if (typeof id !== 'string' || id.length === 0) {
      throw new MetaUnavailableError(200, null, 'no media id in a successful upload response');
    }

    return id;
  }

  /**
   * Trades Meta's exchangeable token code for the customer's business
   * integration system user access token.
   *
   * The one call in this client that authenticates as *the app* rather than
   * with a per-call token: there is no token yet, which is the whole point.
   * `client_id` and `client_secret` go in the query string, as Meta's Tech
   * Provider onboarding guide documents (`GET /{version}/oauth/access_token`
   * with `client_id`, `client_secret` and `code`) — and **no `redirect_uri`**,
   * because the JS SDK returns the code to the opener rather than to a redirect,
   * and sending one Meta never saw is a rejection.
   *
   * The query string is kept out of `path` deliberately: `path` is what a
   * failure logs, and this one carries the app secret and the code.
   *
   * A spent, replayed or malformed code comes back as `MetaRequestRejectedError`
   * through the ordinary classifier, which is the correct reading — the code
   * does not come back, so the retry reasoning that applies to a send does not
   * apply here. The console re-runs the flow for a fresh one.
   */
  async exchangeSignupCode(command: ExchangeSignupCodeCommand): Promise<ExchangedBusinessToken> {
    const payload = await this.request(
      'oauth/access_token',
      { method: 'GET' },
      {
        query: new URLSearchParams({
          client_id: this.requireConfigured('META_APP_ID'),
          client_secret: this.requireConfigured('WHATSAPP_APP_SECRET'),
          code: command.code,
        }),
      },
    );

    const token = readExchangedToken(payload);

    if (token === null) {
      // A 200 with no token is an answer we cannot act on: there is nothing to
      // store and nothing to call Meta with. Transient by the same reasoning as
      // a send with no message id — except that the code is already spent, so
      // the caller reports it rather than retrying.
      throw new MetaUnavailableError(
        200,
        null,
        'no access token in a successful exchange response',
      );
    }

    return token;
  }

  /**
   * Reads one WABA back **with the token just issued for it**.
   *
   * This is the authorization check of the signup flow, not a lookup: the
   * browser asserts a `wabaId`, and the only thing that can confirm the
   * assertion is whether the new token can see it. Meta's own `id` is returned
   * alongside the rest so the caller compares answers rather than trusting the
   * claim it sent.
   */
  async describeBusinessAccount(
    command: DescribeBusinessAccountCommand,
  ): Promise<MetaBusinessAccount> {
    const payload = await this.request(
      command.wabaId,
      { method: 'GET' },
      {
        accessToken: command.accessToken,
        query: this.signed(command.accessToken, {
          fields: 'id,name,business_verification_status',
        }),
      },
    );

    const account = readBusinessAccount(payload);

    if (account === null) {
      throw new MetaUnavailableError(200, null, 'no business account id in a successful response');
    }

    return account;
  }

  /**
   * The WABA's business phone numbers, which is what the connection is actually
   * made of.
   *
   * Read from Meta rather than from the request body on purpose: `verified_name`
   * and the display number are fields the connection requires and the browser
   * does not have, so there is one authority for what was connected and it is
   * the party that issued the token.
   */
  async listPhoneNumbers(command: ListPhoneNumbersCommand): Promise<MetaPhoneNumberPage> {
    const payload = await this.request(
      `${command.wabaId}/phone_numbers`,
      { method: 'GET' },
      {
        accessToken: command.accessToken,
        query: this.signed(command.accessToken, {
          fields: 'id,display_phone_number,verified_name,quality_rating',
          limit: String(PHONE_NUMBER_PAGE_SIZE),
        }),
      },
    );

    return readPhoneNumberPage(payload);
  }

  /**
   * Subscribes this app to the WABA's webhooks.
   *
   * Without it the connection looks healthy and the inbox stays empty: Meta
   * accepts the WABA, the token works, and not one inbound message is ever
   * delivered. Treated as part of connecting rather than as a follow-up for
   * that reason.
   */
  async subscribeApp(command: SubscribeAppCommand): Promise<void> {
    const payload = await this.request(
      `${command.wabaId}/subscribed_apps`,
      { method: 'POST' },
      {
        accessToken: command.accessToken,
        query: this.signed(command.accessToken, {}),
      },
    );

    if (asRecord(payload)?.success !== true) {
      // Meta answers `{ "success": true }`. A 200 saying anything else is a
      // subscription we cannot claim was made, and claiming it is how a tenant
      // ends up with a connected WABA and a silent inbox.
      throw new MetaUnavailableError(200, null, 'the app subscription was not acknowledged');
    }
  }

  /**
   * Registers one phone number for Cloud API use, which is what makes it able to
   * **send** (TAR-170, 0002 amendment 12).
   *
   * A number that was never registered receives normally and refuses every send,
   * which is why this is part of connecting rather than a setting somebody finds
   * later.
   *
   * Returns nothing: Meta answers `{ "success": true }` and there is no id to
   * carry. A 200 saying anything else is a registration this platform cannot
   * claim was made, and claiming it is how a tenant ends up believing a number
   * can send when it cannot — the same reasoning as `subscribeApp` above.
   *
   * **The PIN goes in the JSON body, never in the query string.** `path` and the
   * query are split in `request()` precisely so a failure's log line cannot
   * carry a secret, and `classify()` logs `path`.
   *
   * No new error class: the four this client already raises are the vocabulary,
   * and `classify()` maps this call exactly as it maps every other. What a
   * rejection *means for the row* is the registration service's decision, not
   * this transport's.
   */
  async registerPhoneNumber(command: RegisterPhoneNumberCommand): Promise<void> {
    const payload = await this.request(
      `${command.phoneNumberId}/register`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', pin: command.pin }),
      },
      {
        accessToken: command.accessToken,
        // Signed for the same reason the three signup calls above are: this runs
        // on the business integration system user token, and the proof verifies
        // whether or not the app is configured to require it.
        query: this.signed(command.accessToken, {}),
      },
    );

    if (asRecord(payload)?.success !== true) {
      throw new MetaUnavailableError(
        200,
        null,
        'the phone number registration was not acknowledged',
      );
    }
  }

  /**
   * A configured value the signup flow cannot proceed without.
   *
   * `META_APP_ID` and `WHATSAPP_APP_SECRET` are both optional in the env schema
   * so an environment that does not use the channel still boots (0002, amendment
   * 2). Absent, this refuses **before** the call rather than sending
   * `client_id=undefined` — which Meta answers with a rejection that reads like
   * a bad code and would send the tenant round the flow again for a
   * configuration problem only an operator can fix.
   *
   * `MetaRequestRejectedError` because it is permanent and retrying cannot help,
   * with `status` 0 to say the client refused rather than Meta — the same shape
   * `assertMetaMediaUrl` already uses. The name of the variable is named; its
   * value is not, and never is.
   */
  private requireConfigured(name: 'META_APP_ID' | 'WHATSAPP_APP_SECRET'): string {
    const value = this.config.get<string>(name);

    if (value === undefined || value.length === 0) {
      throw new MetaRequestRejectedError(0, {
        code: null,
        subcode: null,
        message: `Embedded Signup is not configured on this environment: ${name} is not set`,
        traceId: null,
      });
    }

    return value;
  }

  /**
   * Query parameters plus `appsecret_proof`, when the app secret is configured.
   *
   * Meta requires the proof on every call made with a portable token **when the
   * app has "Require App Secret" turned on** (App Dashboard → Settings →
   * Advanced → Security), and accepts it whether or not that setting is on. A
   * business integration system user token is issued to this app, so the proof
   * is HMAC-SHA256 of the token under this app's own secret and verifies under
   * both settings — sending it always is the answer that cannot be wrong, where
   * omitting it fails every call in this flow the day the setting is turned on.
   *
   * Deliberately not applied to the send path: those calls carry tokens from the
   * operator paste path, which this story does not touch. Extending it there is
   * a separate change with its own test.
   *
   * Absent `WHATSAPP_APP_SECRET` the proof is simply omitted rather than
   * refused — the exchange that issued the token already failed closed on the
   * same variable, so a caller holding a token has one.
   */
  private signed(accessToken: string, params: Record<string, string>): URLSearchParams {
    const appSecret = this.config.get<string>('WHATSAPP_APP_SECRET');

    return new URLSearchParams({
      ...params,
      ...(appSecret === undefined || appSecret.length === 0
        ? {}
        : { appsecret_proof: createHmac('sha256', appSecret).update(accessToken).digest('hex') }),
    });
  }

  private async send(
    phoneNumberId: string,
    accessToken: string,
    message: Record<string, unknown>,
  ): Promise<SentMessage> {
    const payload = await this.request(
      `${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...message }),
      },
      { accessToken },
    );

    const providerMessageId = readSentMessageId(payload);

    if (providerMessageId === null) {
      // A 200 with no message id means Meta accepted something we cannot track:
      // no id, so no status webhook can ever be matched to it. Treated as a
      // transient failure so the caller retries rather than recording a message
      // that will sit at `queued` forever.
      throw new MetaUnavailableError(200, null, 'no message id in a successful response');
    }

    return { providerMessageId };
  }

  /**
   * One Graph API round trip: build the URL, attach the bearer token, bound it
   * with a timeout, and turn anything other than a 2xx JSON body into a typed
   * error.
   *
   * `options.timeoutMs` exists for exactly one caller. Every Graph call but the
   * media upload is a small JSON exchange that `META_GRAPH_API_TIMEOUT_MS` sizes
   * correctly; an upload carries up to 100 MB, and holding it to ten seconds
   * would fail every large document while raising the shared value would leave
   * a stalled template list hanging for a minute.
   *
   * `options.query` is separate from `path` rather than concatenated into it
   * because `path` is what a failure logs, and one query string in this client
   * carries the app secret and the signup code (`exchangeSignupCode`). Splitting
   * them is what makes "nothing logs a secret" a property of this method instead
   * of a rule every caller has to remember.
   *
   * `options.accessToken` is optional for exactly one caller too: the code
   * exchange authenticates as the app and has no token yet.
   */
  private async request(
    path: string,
    init: RequestInit,
    options: GraphRequestOptions,
  ): Promise<unknown> {
    const base = this.config.getOrThrow<string>('META_GRAPH_API_BASE_URL');
    const version = this.config.getOrThrow<string>('META_GRAPH_API_VERSION');
    const timeoutMs =
      options.timeoutMs ?? this.config.getOrThrow<number>('META_GRAPH_API_TIMEOUT_MS');
    const query = options.query?.toString();

    const response = await fetch(
      `${base}/${version}/${path}${query === undefined || query.length === 0 ? '' : `?${query}`}`,
      {
        ...init,
        headers: {
          ...init.headers,
          ...(options.accessToken === undefined
            ? {}
            : { authorization: `Bearer ${options.accessToken}` }),
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    ).catch((error: unknown) => {
      // A network failure or the timeout above. `error` is not put in the
      // message: an undici error string quotes the request URL, and the URL
      // carries the phone number id.
      throw new MetaUnavailableError(0, null, describeTransportFailure(error));
    });

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      throw this.classify(response.status, response.headers.get('retry-after'), payload, path);
    }

    return payload;
  }

  /**
   * Maps Meta's answer onto the four errors a caller acts on differently. Order
   * matters: the numeric code is consulted before the HTTP status, because Meta
   * answers 400 both for an expired token and for some throttling —
   * classifying on status alone gets both wrong in the direction that causes
   * harm (an expired credential retried forever, a throttle treated as
   * permanent).
   */
  private classify(
    status: number,
    retryAfter: string | null,
    payload: unknown,
    path: string,
  ): Error {
    const detail = readErrorDetail(payload);
    const code = detail?.code ?? null;

    this.logger.warn(
      `Meta Graph API ${path} failed with HTTP ${status}` +
        `${code === null ? '' : `, code ${code}`}` +
        `${detail?.traceId == null ? '' : `, fbtrace_id ${detail.traceId}`}`,
    );

    if ((code !== null && RATE_LIMIT_CODES.has(code)) || status === 429) {
      return new MetaRateLimitedError(status, detail, parseRetryAfter(retryAfter));
    }

    if ((code !== null && AUTHENTICATION_CODES.has(code)) || status === 401 || status === 403) {
      return new MetaAuthenticationError(status, detail);
    }

    if (status >= 500 || (code !== null && TRANSIENT_CODES.has(code))) {
      return new MetaUnavailableError(status, detail, `HTTP ${status}`);
    }

    return new MetaRequestRejectedError(status, detail);
  }
}

/**
 * `recipient_type: individual` is the only value the Cloud API accepts today,
 * and Meta requires it to be sent. Spelled once rather than in three send
 * methods.
 */
function recipient(to: string): Record<string, unknown> {
  return { recipient_type: 'individual', to };
}

/**
 * The header as Meta's template `components` entry. Each format names its own
 * parameter type and nests the value under a key of that same name — the
 * asymmetry is Meta's, not ours.
 *
 * Coordinates go out as strings: Meta's location parameter is documented as
 * strings, and a number here would be serialised without a trailing zero it may
 * expect.
 */
function headerComponent(header: TemplateHeader): Record<string, unknown> {
  return {
    type: 'header',
    parameters:
      header.format === 'text'
        ? // Positional, exactly as for the body. Meta approves at most one
          // placeholder in a header today, so this is normally one parameter —
          // written as a map rather than a special case so a second one does not
          // need this code changed.
          header.variables.map((text) => ({ type: 'text', text }))
        : [mediaOrLocationParameter(header)],
  };
}

function mediaOrLocationParameter(
  header: Exclude<TemplateHeader, { format: 'text' }>,
): Record<string, unknown> {
  if (header.format === 'location') {
    return {
      type: 'location',
      location: {
        latitude: String(header.latitude),
        longitude: String(header.longitude),
        ...(header.name === undefined ? {} : { name: header.name }),
        ...(header.address === undefined ? {} : { address: header.address }),
      },
    };
  }

  return {
    type: header.format,
    [header.format]: {
      ...('link' in header.media ? { link: header.media.link } : { id: header.media.mediaId }),
      // `filename` is Meta's spelling on the wire; `fileName` is this codebase's
      // (`MessageAttachmentSchema`, and the contract's camelCase rule). This
      // file is the whole boundary between them: every command it accepts says
      // `fileName`, and the two request builders are the only places the wire
      // spelling appears.
      ...(header.fileName === undefined ? {} : { filename: header.fileName }),
    },
  };
}

/** `Retry-After` is seconds or an HTTP date; only the seconds form is acted on. */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) {
    return null;
  }

  const seconds = Number.parseInt(header, 10);

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** `AbortSignal.timeout` rejects with a `TimeoutError`; everything else is the network. */
function describeTransportFailure(error: unknown): string {
  return error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'network failure';
}

function readErrorDetail(payload: unknown): MetaErrorDetail | null {
  const error = asRecord(asRecord(payload)?.error);

  if (error === undefined) {
    return null;
  }

  return {
    code: typeof error.code === 'number' ? error.code : null,
    subcode: typeof error.error_subcode === 'number' ? error.error_subcode : null,
    message: typeof error.message === 'string' ? error.message : 'no reason given',
    traceId: typeof error.fbtrace_id === 'string' ? error.fbtrace_id : null,
  };
}

/**
 * Refuses a media URL that is not on one of Meta's own CDN hosts.
 *
 * Throws rather than returning a boolean: there is one correct reaction to a
 * media URL pointing somewhere unexpected, and making it possible to ignore the
 * answer is how an SSRF guard ends up unused. `MetaRequestRejectedError`
 * because retrying cannot help — the URL will be the same next time — and
 * because it is genuinely Meta's response that is wrong.
 *
 * The URL is not put in the error message: it is a credentialed link, and this
 * message reaches a log.
 */
function assertMetaMediaUrl(candidate: string): void {
  const url = parseUrl(candidate);

  if (url === null || url.protocol !== 'https:') {
    throw new MetaRequestRejectedError(0, {
      code: null,
      subcode: null,
      message: 'Meta returned a media URL that is not an https URL',
      traceId: null,
    });
  }

  const host = url.hostname.toLowerCase();
  const allowed = MEDIA_HOST_SUFFIXES.some(
    (suffix) => host.endsWith(suffix) || host === suffix.slice(1),
  );

  if (!allowed) {
    throw new MetaRequestRejectedError(0, {
      code: null,
      subcode: null,
      message: `Meta returned a media URL on an unexpected host: ${host}`,
      traceId: null,
    });
  }
}

function parseUrl(candidate: string): URL | null {
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

/**
 * `{ url, mime_type, sha256, file_size }`, defensively.
 *
 * Only `url` is required — it is the one field without which there is nothing
 * to do. The rest is Meta's description of the bytes, and the caller measures
 * the bytes it actually receives rather than trusting any of it.
 */
function readMediaDescriptor(payload: unknown): MetaMediaDescriptor | null {
  const media = asRecord(payload);
  const url = media?.url;

  if (typeof url !== 'string' || url.length === 0) {
    return null;
  }

  return {
    url,
    mimeType: typeof media?.mime_type === 'string' ? media.mime_type : null,
    // Meta sends `file_size` as a number in current versions and has sent it as
    // a numeric string in older ones. Both are read; anything else is absent.
    sizeBytes: readPositiveInteger(media?.file_size),
    sha256: typeof media?.sha256 === 'string' ? media.sha256.toLowerCase() : null,
  };
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;

  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** `{ messages: [{ id: 'wamid…' }] }`, defensively — a shape Meta owns and may extend. */
function readSentMessageId(payload: unknown): string | null {
  const messages = asRecord(payload)?.messages;

  if (!Array.isArray(messages)) {
    return null;
  }

  const id = asRecord(messages[0])?.id;

  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * `{ data: [...], paging: { cursors: { after }, next } }`.
 *
 * `paging.next` is what decides whether there is another page: Meta returns a
 * `cursors.after` on the *last* page too, so following it unconditionally is an
 * infinite loop that re-reads the final page forever.
 */
function readTemplatePage(payload: unknown): MetaMessageTemplatePage {
  const root = asRecord(payload);
  const data = root?.data;
  const paging = asRecord(root?.paging);
  const after = asRecord(paging?.cursors)?.after;

  const hasNextPage = typeof paging?.next === 'string' && paging.next.length > 0;

  return {
    templates: (Array.isArray(data) ? data : []).flatMap(readTemplate),
    nextAfter: hasNextPage && typeof after === 'string' && after.length > 0 ? after : null,
  };
}

/**
 * Returns an empty array — rather than a partial template — for a row missing
 * the two fields that identify it. A template with no name or no language cannot
 * be keyed, so storing it would create a row nothing can ever match or update.
 */
function readTemplate(raw: unknown): MetaMessageTemplate[] {
  const template = asRecord(raw);

  if (template === undefined) {
    return [];
  }

  const { name, language } = template;

  if (typeof name !== 'string' || typeof language !== 'string') {
    return [];
  }

  const status =
    typeof template.status === 'string' ? TEMPLATE_STATUSES[template.status] : undefined;

  return [
    {
      name,
      language,
      category: typeof template.category === 'string' ? template.category : null,
      status: status ?? null,
      components: template.components ?? null,
      providerTemplateId: typeof template.id === 'string' ? template.id : null,
    },
  ];
}

/**
 * `{ access_token, token_type }`, and `expires_in` if Meta ever sends one.
 *
 * Only `access_token` is required — `token_type` is `bearer` and carries no
 * decision. `expires_in` is read rather than ignored precisely because Meta's
 * documented response for this flow does not contain it: if it appears, the
 * assumption that a connected WABA's credential keeps working has changed, and
 * the caller needs to be able to see that rather than discover it weeks later
 * as a tenant's inbox going quiet.
 */
function readExchangedToken(payload: unknown): ExchangedBusinessToken | null {
  const accessToken = asRecord(payload)?.access_token;

  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return null;
  }

  return {
    accessToken,
    expiresInSeconds: readPositiveInteger(asRecord(payload)?.expires_in),
  };
}

/** `{ id, name, business_verification_status }`, defensively. */
function readBusinessAccount(payload: unknown): MetaBusinessAccount | null {
  const account = asRecord(payload);
  const wabaId = account?.id;

  if (typeof wabaId !== 'string' || wabaId.length === 0) {
    return null;
  }

  const status = account?.business_verification_status;

  return {
    wabaId,
    name: typeof account?.name === 'string' ? account.name : null,
    verificationStatus:
      typeof status === 'string'
        ? (BUSINESS_VERIFICATION_STATUSES[status.toLowerCase()] ?? null)
        : null,
  };
}

/**
 * `{ data: [...], paging: { next } }`.
 *
 * `paging.next` decides `hasMore` for the same reason it decides the template
 * cursor: Meta returns `cursors.after` on the last page too.
 */
function readPhoneNumberPage(payload: unknown): MetaPhoneNumberPage {
  const root = asRecord(payload);
  const data = root?.data;
  const next = asRecord(root?.paging)?.next;

  return {
    phoneNumbers: (Array.isArray(data) ? data : []).flatMap(readPhoneNumber),
    hasMore: typeof next === 'string' && next.length > 0,
  };
}

/**
 * Drops a number missing its id or its display form, rather than returning a
 * partial one. Both are required by `ConnectWhatsAppPhoneNumberInputSchema`, so
 * a half-read number would fail validation one layer up with nothing to say
 * about which of Meta's rows was at fault.
 */
function readPhoneNumber(raw: unknown): MetaPhoneNumber[] {
  const number = asRecord(raw);

  if (number === undefined) {
    return [];
  }

  const { id, display_phone_number: displayPhoneNumber } = number;

  if (typeof id !== 'string' || id.length === 0 || typeof displayPhoneNumber !== 'string') {
    return [];
  }

  const rating = number.quality_rating;

  return [
    {
      phoneNumberId: id,
      displayPhoneNumber,
      verifiedName: typeof number.verified_name === 'string' ? number.verified_name : null,
      qualityRating:
        typeof rating === 'string' ? (QUALITY_RATINGS[rating.toUpperCase()] ?? null) : null,
    },
  ];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
