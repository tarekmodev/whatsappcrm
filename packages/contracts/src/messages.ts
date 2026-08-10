import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';
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
  url: z.url().nullable(),
  mimeType: z.string(),
  fileName: z.string().nullable(),
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
  /** True when the AI chatbot (TAR-28) or a workflow (TAR-27) produced the message. */
  sentByAutomation: z.boolean(),
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
    fileName: z.string().min(1).max(255).optional(),
  }),
  z.object({
    format: z.literal('location'),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    name: z.string().min(1).max(200).optional(),
    address: z.string().min(1).max(500).optional(),
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
export type MessageType = z.infer<typeof MessageTypeSchema>;
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;
export type MessageResponse = z.infer<typeof MessageResponseSchema>;
export type SendTemplateHeader = z.infer<typeof SendTemplateHeaderSchema>;
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;
export type MessageListQuery = z.infer<typeof MessageListQuerySchema>;
