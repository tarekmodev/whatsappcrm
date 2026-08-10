import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MessageTemplateStatus } from '@whatsappcrm/contracts';
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
    const query = new URLSearchParams({
      fields: 'id,name,language,category,status,components',
      limit: String(TEMPLATE_PAGE_SIZE),
      ...(command.after === undefined ? {} : { after: command.after }),
    });

    const payload = await this.request(
      `${command.wabaId}/message_templates?${query.toString()}`,
      { method: 'GET' },
      command.accessToken,
    );

    return readTemplatePage(payload);
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
      accessToken,
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
   */
  private async request(path: string, init: RequestInit, accessToken: string): Promise<unknown> {
    const base = this.config.getOrThrow<string>('META_GRAPH_API_BASE_URL');
    const version = this.config.getOrThrow<string>('META_GRAPH_API_VERSION');
    const timeoutMs = this.config.getOrThrow<number>('META_GRAPH_API_TIMEOUT_MS');

    const response = await fetch(`${base}/${version}/${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error: unknown) => {
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
