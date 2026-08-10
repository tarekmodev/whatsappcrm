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
 * The only message type permitted once the 24-hour customer service window has
 * closed. Anything else in that state returns `whatsapp_window_expired`.
 */
export const SendTemplateInputSchema = z.object({
  type: z.literal('template'),
  templateName: z.string().min(1),
  languageCode: z.string().min(2).max(10),
  /** Positional substitutions, matching the approved template's placeholders. */
  variables: z.array(z.string()).default([]),
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
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;
export type MessageListQuery = z.infer<typeof MessageListQuerySchema>;
