import { z } from 'zod';

/**
 * WhatsApp Cloud API webhook ingestion. TAR-20 implements the processor; the
 * ingest controller itself is specified here because TAR-38's ADR made its
 * durability rule a constraint on this design rather than a later choice.
 *
 * **The rule, restated:** persist the raw payload to Postgres, answer `200`,
 * *then* enqueue. Meta retries with backoff and eventually gives up, so
 * enqueueing straight to Redis would turn a Redis outage into silent, permanent
 * message loss. Writing to Postgres first makes Redis a latency dependency
 * instead of a durability one.
 */

/** Meta signs the raw request body with the app secret, HMAC-SHA256, hex, `sha256=` prefixed. */
export const WHATSAPP_SIGNATURE_HEADER = 'x-hub-signature-256';

/**
 * Meta's `GET` verification handshake, performed once when the webhook URL is
 * registered. Echo `hub.challenge` verbatim, and only when the token matches.
 */
export const WebhookVerifyQuerySchema = z.object({
  'hub.mode': z.literal('subscribe'),
  'hub.verify_token': z.string().min(1),
  'hub.challenge': z.string().min(1),
});

/**
 * The envelope, modelled only as deeply as routing requires.
 *
 * Everything below `value` stays `unknown` on purpose: Meta adds fields without
 * warning, and a strict schema here would reject real customer messages in
 * production. The processor — which runs after the payload is already durably
 * stored — does the detailed parsing, where a parse failure is a retriable job
 * rather than a dropped message.
 */
export const WhatsAppWebhookEnvelopeSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      /** The WhatsApp Business Account id. */
      id: z.string(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            messaging_product: z.literal('whatsapp').optional(),
            metadata: z
              .object({
                display_phone_number: z.string().optional(),
                /** The tenant routing key: maps to exactly one `WhatsAppAccount`. */
                phone_number_id: z.string(),
              })
              .optional(),
          }),
        }),
      ),
    }),
  ),
});

export type WhatsAppWebhookEnvelope = z.infer<typeof WhatsAppWebhookEnvelopeSchema>;

/**
 * Lifecycle of a stored webhook payload.
 *
 * `received → processing → processed`, or `→ failed` after the retry budget is
 * spent. The sweeper re-enqueues anything stuck in `received` or `processing`
 * past a threshold, which is what makes a Redis outage recoverable rather than
 * lossy.
 */
export const WEBHOOK_EVENT_STATUSES = ['received', 'processing', 'processed', 'failed'] as const;
export const WebhookEventStatusSchema = z.enum(WEBHOOK_EVENT_STATUSES);
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

export const WEBHOOK_PROVIDERS = ['whatsapp', 'billing'] as const;
export const WebhookProviderSchema = z.enum(WEBHOOK_PROVIDERS);
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];
