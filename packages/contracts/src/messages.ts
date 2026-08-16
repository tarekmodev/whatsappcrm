import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';
import { MediaDownloadStateSchema, MediaKindSchema } from './media';
import { CursorPageQuerySchema } from './pagination';

/**
 * Messages — the highest-volume entity in the system, and the one every other
 * feature reads. TAR-20 implements send and receive.
 */

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export const MessageDirectionSchema = z.enum(MESSAGE_DIRECTIONS);

export const MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'template',
  'system',
  /** Anything Meta sends that we do not model yet — recorded rather than dropped. */
  'unsupported',
] as const;
export const MessageTypeSchema = z.enum(MESSAGE_TYPES);

/**
 * Who authored a message (0010 decision 14, TAR-28).
 *
 * `sentByAutomation` is derived from "outbound with no sender", and TAR-27's
 * workflows are about to send with a null sender too — so that flag stops
 * distinguishing a bot reply from a workflow reply, and the console has to badge
 * exactly one of them. Both stay published; `sentByAutomation` keeps its meaning
 * as `origin` being neither `contact` nor `agent`.
 *
 * `workflow` is deliberately absent: it is TAR-27's value to append when its send
 * action lands. The list is written to be extended rather than replaced.
 */
export const MESSAGE_ORIGINS = ['contact', 'agent', 'bot', 'system'] as const;
export const MessageOriginSchema = z.enum(MESSAGE_ORIGINS);

/**
 * Outbound lifecycle: `queued → sent → delivered → read`, or `failed`.
 * Inbound messages are born `delivered` — there is nothing to track.
 */
export const MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed'] as const;
export const MessageStatusSchema = z.enum(MESSAGE_STATUSES);
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * Status only ever moves forward. Meta's status webhooks arrive out of order
 * often enough that this matters: the writer compares ranks and ignores
 * regressions instead of overwriting blindly, so a late `sent` cannot un-read a
 * message.
 */
export const MESSAGE_STATUS_RANK: Record<MessageStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  /** Terminal and off the ladder: a failure is never overwritten by a late success. */
  failed: 99,
};

export function isMessageStatusAdvance(from: MessageStatus, to: MessageStatus): boolean {
  if (from === 'failed') return false;
  return MESSAGE_STATUS_RANK[to] > MESSAGE_STATUS_RANK[from];
}

export const MessageAttachmentSchema = z.object({
  id: IdSchema,
  /** Meta's media handle. Media is fetched and re-hosted, because the handle expires. */
  providerMediaId: z.string().nullable(),
  /**
   * Where the re-hosted bytes are — absolute, built at the response boundary
   * from the request's own origin rather than stored, so the same row serves a
   * platform subdomain and a tenant's custom domain (TAR-29) correctly.
   *
   * `null` while `downloadState` is `pending` or `failed`: an inbound download
   * runs off the ingest path, so a message can exist before its picture does.
   */
  url: z.url().nullable(),
  /**
   * What the attachment is. Published alongside `mimeType` because the inbox
   * picks a renderer from the kind, not from the media type — `image/webp` is a
   * sticker and `image/png` is a photo, and they do not render the same way.
   */
  kind: MediaKindSchema,
  downloadState: MediaDownloadStateSchema,
  mimeType: z.string(),
  fileName: z.string().nullable(),
  /** Known once the bytes are stored, which for an inbound attachment is not immediately. */
  sizeBytes: z.int().nonnegative().nullable(),
});

export const MessageResponseSchema = z.object({
  id: IdSchema,
  conversationId: IdSchema,
  direction: MessageDirectionSchema,
  type: MessageTypeSchema,
  status: MessageStatusSchema,
  /** Present for `text`, and used as the caption for media types. */
  body: z.string().nullable(),
  attachments: z.array(MessageAttachmentSchema),
  /** Set on outbound agent replies; null for inbound and for automation sends. */
  sentByUserId: IdSchema.nullable(),
  /**
   * True when the AI chatbot (TAR-28) or a workflow (TAR-27) produced the
   * message. **Unchanged in meaning**, now derived from `origin`.
   */
  sentByAutomation: z.boolean(),
  /**
   * Who authored the message (0010 decision 14). Additive, and the field a
   * console badges a bot reply from — `sentByAutomation` cannot tell a bot
   * reply from a workflow reply or a delivery placeholder.
   */
  origin: MessageOriginSchema,
  /** Meta's id. Unique per tenant, and the idempotency key for webhook replays. */
  providerMessageId: z.string().nullable(),
  /** Meta's error code and title, when `status` is `failed`. */
  failureReason: z.string().nullable(),
  /**
   * The provider's timestamp, not our insert time. Threads sort by this, because
   * webhook delivery order does not match the order the customer sent things in.
   */
  sentAt: TimestampSchema,
  createdAt: TimestampSchema,
});

/**
 * Sending is one endpoint with a discriminated body rather than three, so the
 * service-window check, quota accounting and idempotency live in exactly one
 * handler and cannot drift apart.
 */
export const SendTextInputSchema = z.object({
  type: z.literal('text'),
  body: z.string().min(1).max(4096),
});

export const SendMediaInputSchema = z.object({
  type: z.enum(['image', 'video', 'audio', 'document']),
  /** Id returned by `POST /api/v1/media`; the API re-hosts before sending. */
  mediaId: IdSchema,
  caption: z.string().max(1024).optional(),
});

/**
 * What a template's header needs at send time, discriminated on the same
 * vocabulary `MessageTemplateResponse.headerFormat` publishes (0002, amendment
 * 1).
 *
 * Without this slot a template with an IMAGE header passes the approved-only
 * filter, renders its body inputs, satisfies the arity check, and then fails at
 * Meta for want of a header — the opaque provider error `parameterCount` exists
 * to prevent, reached through the field added to prevent it.
 *
 * A `location` header carries no placeholder, which is why it takes coordinates
 * rather than variables: Meta renders the map from the values supplied at send
 * time, and the approved template fixes nothing about it.
 */
/**
 * The bounds `SendTemplateHeaderSchema` enforces, named so the composer can
 * enforce them too.
 *
 * The console fills these fields, and it has to keep what it collects inside the
 * schema before it submits — a file name taken from the agent's operating system
 * is not something they typed, and bouncing a send for it would be a refusal
 * about a value nobody chose. Read from here rather than restated there, so the
 * two cannot drift.
 */
export const SEND_TEMPLATE_HEADER_LIMITS = {
  fileNameMaxLength: 255,
  latitudeLimit: 90,
  longitudeLimit: 180,
  locationNameMaxLength: 200,
  locationAddressMaxLength: 500,
} as const;

export const SendTemplateHeaderSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('text'),
    /** Positional, and exactly `headerParameterCount` long. */
    variables: z.array(z.string()).min(1),
  }),
  z.object({
    format: z.enum(['image', 'video', 'document']),
    /** Id returned by `POST /api/v1/media`; the API re-hosts before sending. */
    mediaId: IdSchema,
    /** `document` only; what the recipient sees as the file name. */
    fileName: z.string().min(1).max(SEND_TEMPLATE_HEADER_LIMITS.fileNameMaxLength).optional(),
  }),
  z.object({
    format: z.literal('location'),
    latitude: z
      .number()
      .min(-SEND_TEMPLATE_HEADER_LIMITS.latitudeLimit)
      .max(SEND_TEMPLATE_HEADER_LIMITS.latitudeLimit),
    longitude: z
      .number()
      .min(-SEND_TEMPLATE_HEADER_LIMITS.longitudeLimit)
      .max(SEND_TEMPLATE_HEADER_LIMITS.longitudeLimit),
    name: z.string().min(1).max(SEND_TEMPLATE_HEADER_LIMITS.locationNameMaxLength).optional(),
    address: z.string().min(1).max(SEND_TEMPLATE_HEADER_LIMITS.locationAddressMaxLength).optional(),
  }),
]);

/**
 * The only message type permitted once the 24-hour customer service window has
 * closed. Anything else in that state returns `whatsapp_window_expired`.
 *
 * `variables` matches the template's `parameterCount` — BODY placeholders only.
 * A header is supplied through `header` and counted separately in
 * `headerParameterCount`, because the two go through different slots and one
 * total could not say which. The send handler (TAR-68) requires `header`
 * exactly when the named template publishes a non-null `headerFormat`, refuses
 * it otherwise, and requires the two formats to agree — all three before the
 * Cloud API call, which is the point of publishing the fields at all.
 */
export const SendTemplateInputSchema = z.object({
  type: z.literal('template'),
  templateName: z.string().min(1),
  languageCode: z.string().min(2).max(10),
  /** Positional substitutions, matching the approved template's BODY placeholders. */
  variables: z.array(z.string()).default([]),
  header: SendTemplateHeaderSchema.optional(),
});

export const SendMessageInputSchema = z.discriminatedUnion('type', [
  SendTextInputSchema,
  SendMediaInputSchema,
  SendTemplateInputSchema,
]);

export const MessageListQuerySchema = CursorPageQuerySchema.extend({
  /** Threads page backwards from newest by default; `asc` exists for exports. */
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type MessageDirection = z.infer<typeof MessageDirectionSchema>;
export type MessageOrigin = (typeof MESSAGE_ORIGINS)[number];
export type MessageType = z.infer<typeof MessageTypeSchema>;
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;
export type MessageResponse = z.infer<typeof MessageResponseSchema>;
export type SendTemplateHeader = z.infer<typeof SendTemplateHeaderSchema>;
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;
/**
 * The three arms of the send union, named individually.
 *
 * `SendMessageInput` is what a handler receives; these are what it narrows to,
 * and the send path (TAR-68) branches on all three — the service window admits
 * only the template arm once it has closed, and only the media arm names a
 * `mediaId` to resolve. Published rather than re-derived with `Extract<…>` at
 * each call site, so the name of an arm is the contract's to change.
 */
export type SendTextInput = z.infer<typeof SendTextInputSchema>;
export type SendMediaInput = z.infer<typeof SendMediaInputSchema>;
export type SendTemplateInput = z.infer<typeof SendTemplateInputSchema>;
export type MessageListQuery = z.infer<typeof MessageListQuerySchema>;
