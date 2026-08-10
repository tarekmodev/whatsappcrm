import { z } from 'zod';

/**
 * Meta's `messages` webhook, modelled as deeply as the **processor** needs.
 *
 * `@whatsappcrm/contracts` publishes `WhatsAppWebhookEnvelopeSchema`, which goes
 * only as deep as routing: the ingest controller uses that one, because the
 * payload is stored before it is understood and a strict schema at the edge
 * would reject real customer messages. This schema is the next layer down. It
 * runs in the worker, after the payload is already durable, where a parse
 * failure is a retriable job rather than a dropped message — which is what makes
 * it safe to be specific here and lenient there.
 *
 * It stays lenient in one direction on purpose: **unknown message types parse**.
 * Meta ships new ones without warning, and `unsupported` records them rather
 * than failing the batch, so the thread shows that something arrived even when
 * the product cannot render it yet.
 */

/** Meta sends UNIX seconds, as a string. */
const ProviderTimestampSchema = z
  .string()
  .regex(/^\d+$/, 'Expected UNIX seconds')
  .transform((seconds) => new Date(Number(seconds) * 1_000));

const MediaSchema = z.object({
  id: z.string().optional(),
  mime_type: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
});

/**
 * One inbound message. `type` is a plain string rather than an enum for the
 * reason above; `toContentType` is what narrows it.
 */
const InboundMessageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: ProviderTimestampSchema,
  type: z.string().min(1),
  text: z.object({ body: z.string() }).optional(),
  image: MediaSchema.optional(),
  video: MediaSchema.optional(),
  audio: MediaSchema.optional(),
  document: MediaSchema.optional(),
  sticker: MediaSchema.optional(),
  button: z.object({ text: z.string().optional() }).optional(),
  interactive: z
    .object({
      button_reply: z.object({ title: z.string().optional() }).optional(),
      list_reply: z.object({ title: z.string().optional() }).optional(),
    })
    .optional(),
  reaction: z.object({ emoji: z.string().optional() }).optional(),
});

/**
 * One status transition for a message **we** sent. `status` is an open string:
 * Meta has added values (`deleted`) since the four the product models, and an
 * enum here would fail the whole batch over one of them.
 */
const MessageStatusUpdateSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  timestamp: ProviderTimestampSchema,
  recipient_id: z.string().min(1),
  errors: z
    .array(
      z.object({
        code: z.union([z.string(), z.number()]).optional(),
        title: z.string().optional(),
      }),
    )
    .optional(),
});

/** The contact profile Meta attaches to an inbound batch, when it has one. */
const ProfileSchema = z.object({
  wa_id: z.string().min(1),
  profile: z.object({ name: z.string().optional() }).optional(),
});

export const WhatsAppChangeValueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string().min(1) }),
  contacts: z.array(ProfileSchema).optional(),
  messages: z.array(InboundMessageSchema).optional(),
  statuses: z.array(MessageStatusUpdateSchema).optional(),
});

export const WhatsAppNotificationSchema = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          /**
           * `messages` is the only field this pipeline acts on. Meta subscribes
           * an app to others — `message_template_status_update`,
           * `account_update` — on the same URL, and those are recorded and
           * skipped rather than treated as an error.
           */
          field: z.string(),
          value: WhatsAppChangeValueSchema,
        }),
      ),
    }),
  ),
});

export type WhatsAppNotification = z.infer<typeof WhatsAppNotificationSchema>;
export type WhatsAppChangeValue = z.infer<typeof WhatsAppChangeValueSchema>;
export type WhatsAppInboundMessage = z.infer<typeof InboundMessageSchema>;
export type WhatsAppMessageStatusUpdate = z.infer<typeof MessageStatusUpdateSchema>;
export type WhatsAppProfile = z.infer<typeof ProfileSchema>;

/** The `field` this pipeline processes. Everything else is a no-op. */
export const MESSAGES_FIELD = 'messages';
