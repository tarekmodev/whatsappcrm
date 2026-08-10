import { z } from 'zod';
import { IdSchema, PhoneE164Schema, TimestampSchema } from './common';

/**
 * The WhatsApp channel's own entities, at the three levels Meta scopes them
 * (TAR-39, question 6; modelled by TAR-52):
 *
 *   Tenant ──< WhatsAppBusinessAccount ──< WhatsAppAccount   (phone numbers)
 *                                     └──< MessageTemplate
 *
 * A tenant may hold several WABAs, each with one or more numbers. Meta approves
 * templates per WABA and issues the access token per WABA; it rates quality and
 * sets messaging limits per number. That split is the whole reason these are
 * three schemas and not one.
 *
 * **No schema here carries the access token, in any form.** It is encrypted at
 * rest on `whatsapp_business_accounts` and decrypted only in the send path
 * (TAR-39, security). Zod strips unknown keys on parse, so a handler that
 * selected it by accident cannot leak it through a response validated with
 * `WhatsAppBusinessAccountResponseSchema` — `contract.test.ts` asserts that.
 *
 * TAR-20 owns the endpoints, the Embedded Signup flow and the request bodies
 * that go with them. These are the resource shapes those endpoints return.
 */

/**
 * Where a WABA stands with Meta. The lifecycle rather than a transcription of
 * Meta's field: Meta exposes two vocabularies here — the business's
 * `verification_status` and the WABA's `account_review_status` — and TAR-39
 * records which one Embedded Signup returns as unverified. TAR-20 confirms it
 * against Meta's current documentation and maps onto these four.
 */
export const WHATSAPP_BUSINESS_VERIFICATION_STATUSES = [
  'not_verified',
  'pending',
  'verified',
  'rejected',
] as const;
export const WhatsAppBusinessVerificationStatusSchema = z.enum(
  WHATSAPP_BUSINESS_VERIFICATION_STATUSES,
);

export const WhatsAppBusinessAccountResponseSchema = z.object({
  id: IdSchema,
  /** Meta's own id for the business account. Unique across the platform. */
  wabaId: z.string().min(1),
  /**
   * The business name Meta reports. Display only, and nullable — two WABAs
   * under one tenant are otherwise indistinguishable in an operator's list.
   */
  name: z.string().nullable(),
  verificationStatus: WhatsAppBusinessVerificationStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/**
 * Meta's per-number quality rating. `unknown` is a value Meta itself returns;
 * `null` means we have not read it yet. Kept distinct because "Meta says it
 * cannot rate this number" and "we have not asked" call for different UI.
 */
export const WHATSAPP_QUALITY_RATINGS = ['green', 'yellow', 'red', 'unknown'] as const;
export const WhatsAppQualityRatingSchema = z.enum(WHATSAPP_QUALITY_RATINGS);

export const WHATSAPP_ACCOUNT_STATUSES = ['connected', 'disconnected', 'error'] as const;
export const WhatsAppAccountStatusSchema = z.enum(WHATSAPP_ACCOUNT_STATUSES);

/** One connected phone number, child of a WABA. */
export const WhatsAppAccountResponseSchema = z.object({
  id: IdSchema,
  /** The WABA this number belongs to. Never inferred from the tenant — a tenant may hold several. */
  whatsappBusinessAccountId: IdSchema,
  /**
   * Meta's id for the number, and the webhook routing key: an inbound event
   * names the number, not the business, so this stays the lookup regardless of
   * how many WABAs sit behind it.
   */
  phoneNumberId: z.string().min(1),
  displayPhoneNumber: PhoneE164Schema,
  /** The name Meta has verified for this number, once it has. */
  verifiedName: z.string().nullable(),
  qualityRating: WhatsAppQualityRatingSchema.nullable(),
  status: WhatsAppAccountStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const MESSAGE_TEMPLATE_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled',
] as const;
export const MessageTemplateStatusSchema = z.enum(MESSAGE_TEMPLATE_STATUSES);

/**
 * A template belongs to the WABA that submitted it, so `name` + `language` is
 * unique only *within* a WABA. One tenant with two WABAs may legitimately hold
 * `order_update`/`en` in both, with different content and different approval
 * status — which is why `whatsappBusinessAccountId` is part of this shape and
 * not an implementation detail.
 *
 * `SendTemplateInputSchema` (`messages.ts`) still names a template by
 * `templateName` + `languageCode` and no WABA, and remains correct: a send is
 * addressed to a conversation, the conversation names the number, and the
 * number names exactly one WABA. The send path resolves the WABA rather than
 * asking the caller for it.
 */
export const MessageTemplateResponseSchema = z.object({
  id: IdSchema,
  whatsappBusinessAccountId: IdSchema,
  name: z.string().min(1),
  /** Meta's language tag for the template, e.g. `en_US` — its format, not BCP 47. */
  language: z.string().min(2),
  category: z.string().nullable(),
  status: MessageTemplateStatusSchema,
  /**
   * Meta's component tree, passed through verbatim and deliberately not
   * validated here: its shape is Meta's to change, and a schema that guessed at
   * it would start rejecting valid templates the first time Meta added a field.
   */
  components: z.unknown().nullable(),
  /** Meta's id for the template, once it has issued one. */
  providerTemplateId: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type WhatsAppBusinessVerificationStatus = z.infer<
  typeof WhatsAppBusinessVerificationStatusSchema
>;
export type WhatsAppBusinessAccountResponse = z.infer<typeof WhatsAppBusinessAccountResponseSchema>;
export type WhatsAppQualityRating = z.infer<typeof WhatsAppQualityRatingSchema>;
export type WhatsAppAccountStatus = z.infer<typeof WhatsAppAccountStatusSchema>;
export type WhatsAppAccountResponse = z.infer<typeof WhatsAppAccountResponseSchema>;
export type MessageTemplateStatus = z.infer<typeof MessageTemplateStatusSchema>;
export type MessageTemplateResponse = z.infer<typeof MessageTemplateResponseSchema>;
