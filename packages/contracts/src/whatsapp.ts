import { z } from 'zod';
import { IdSchema, PhoneE164Schema, TimestampSchema } from './common';
import { CursorPageQuerySchema } from './pagination';
import { TenantSlugSchema } from './tenant';

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

// ---------------------------------------------------------------------------
// Connecting a WABA — the admin surface (TAR-20a)
// ---------------------------------------------------------------------------

/**
 * Meta's own ids are decimal strings, and they arrive as strings everywhere in
 * the Graph API. Validated as digits rather than as a number: they exceed
 * `Number.MAX_SAFE_INTEGER`, so parsing one would silently change it.
 *
 * The upper bound is a denial-of-service guard, not a claim about Meta's
 * format — an unbounded string here becomes an unbounded index key.
 */
const MetaGraphIdSchema = z.string().regex(/^\d{1,32}$/, 'Must be a Meta Graph id (digits only)');

export const MetaWabaIdSchema = MetaGraphIdSchema;
export const MetaPhoneNumberIdSchema = MetaGraphIdSchema;

/**
 * One phone number to attach to the WABA being connected.
 *
 * `phoneNumberId` is globally unique — it is the webhook routing key — so
 * connecting a number another tenant already holds is a `conflict`, never a
 * silent takeover.
 */
export const ConnectWhatsAppPhoneNumberInputSchema = z.object({
  phoneNumberId: MetaPhoneNumberIdSchema,
  displayPhoneNumber: PhoneE164Schema,
  verifiedName: z.string().min(1).max(200).optional(),
  /** Omitted on a fresh connection: Meta has not rated a number nobody has messaged. */
  qualityRating: WhatsAppQualityRatingSchema.optional(),
});

/**
 * `POST /api/v1/admin/tenants/{slug}/whatsapp/business-accounts` — connect a
 * WABA and its numbers to a tenant.
 *
 * `wabaId` is the identity of the request, which is what makes the operation
 * idempotent: connecting the same WABA twice updates the row rather than
 * creating a second one, and re-sending a token is how rotation is performed.
 *
 * `accessToken` is the per-business credential Meta issues. It is written
 * encrypted and is **never** read back by any response schema in this file — see
 * the note at the top.
 */
export const ConnectWhatsAppBusinessAccountInputSchema = z.object({
  wabaId: MetaWabaIdSchema,
  name: z.string().min(1).max(200).optional(),
  /**
   * Bounded at both ends. The floor rejects an obviously empty placeholder; the
   * ceiling stops an arbitrary blob being encrypted into a row. Neither is a
   * claim about Meta's token format, which Meta does not publish.
   */
  accessToken: z.string().min(20).max(512),
  verificationStatus: WhatsAppBusinessVerificationStatusSchema.optional(),
  /**
   * At least one: a WABA with no number can neither send nor receive, so
   * connecting one would record configuration that cannot be used. The ceiling
   * bounds the work a single request can ask for.
   */
  phoneNumbers: z
    .array(ConnectWhatsAppPhoneNumberInputSchema)
    .min(1)
    .max(20)
    .refine(
      (numbers) => new Set(numbers.map((number) => number.phoneNumberId)).size === numbers.length,
      'Each phone number id may appear only once',
    ),
});

/** The tenant a platform-admin WhatsApp route acts on, named the way an operator has it. */
export const WhatsAppAdminTenantParamsSchema = z.object({
  slug: TenantSlugSchema,
});

/** Identifies one connected WABA under `WhatsAppAdminTenantParamsSchema`'s tenant. */
export const WhatsAppAdminBusinessAccountParamsSchema = WhatsAppAdminTenantParamsSchema.extend({
  wabaId: MetaWabaIdSchema,
});

/**
 * What a connection reports: the WABA as stored, plus every number now attached
 * to it. The numbers are returned because the operator's next question is always
 * "did all of them land", and answering it should not need a second call.
 *
 * Built by extending the resource schema rather than restating it, so a field
 * added to a WABA cannot be forgotten here.
 */
export const ConnectedWhatsAppBusinessAccountResponseSchema =
  WhatsAppBusinessAccountResponseSchema.extend({
    accounts: z.array(WhatsAppAccountResponseSchema),
  });

/**
 * `POST /api/v1/admin/tenants/{slug}/whatsapp/business-accounts/{wabaId}/template-sync`
 * — pull this WABA's templates from Meta and reconcile them.
 *
 * The counts are the whole point of the response: a sync that reports
 * `created: 0, updated: 0` against a WABA an operator has just had templates
 * approved for is the signal that something is wrong with the connection.
 *
 * `total` is what Meta returned, so `created + updated` falling short of it says
 * a template was skipped — a status this version does not model — rather than
 * leaving that invisible.
 */
export const SyncMessageTemplatesResponseSchema = z.object({
  whatsappBusinessAccountId: IdSchema,
  wabaId: MetaWabaIdSchema,
  created: z.int().nonnegative(),
  updated: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  total: z.int().nonnegative(),
  syncedAt: TimestampSchema,
});

// ---------------------------------------------------------------------------
// Reading templates — the tenant surface (TAR-20a)
// ---------------------------------------------------------------------------

/**
 * `GET /api/v1/message-templates` — the approved templates an agent may send.
 *
 * Not in TAR-39's fixed stage-1 endpoint list; added here under the same
 * conventions, and required by the composer, which has to offer a template the
 * moment the 24-hour service window closes.
 *
 * **Approved only, and not a filter.** An agent cannot send a `pending`,
 * `rejected`, `paused` or `disabled` template — Meta refuses it — so offering
 * one in a picker produces a failed send and a confused agent. A `status` query
 * parameter would make that reachable by accident, so there is none. Template
 * *administration*, which does need to show the rejected ones, is a separate
 * surface with its own permission.
 *
 * `whatsappBusinessAccountId` narrows to one WABA, which is what the composer
 * needs: a conversation names a number, the number names exactly one WABA, and
 * only that WABA's templates can be sent on it. Optional, because an
 * administrative list spanning a tenant's WABAs is also legitimate.
 */
export const MessageTemplateListQuerySchema = CursorPageQuerySchema.extend({
  whatsappBusinessAccountId: IdSchema.optional(),
});

/** `{ items, nextCursor }` per TAR-39's list convention — no envelope. */
export const MessageTemplatePageSchema = z.object({
  items: z.array(MessageTemplateResponseSchema),
  nextCursor: z.string().nullable(),
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

export type ConnectWhatsAppPhoneNumberInput = z.infer<typeof ConnectWhatsAppPhoneNumberInputSchema>;
export type ConnectWhatsAppBusinessAccountInput = z.infer<
  typeof ConnectWhatsAppBusinessAccountInputSchema
>;
export type WhatsAppAdminTenantParams = z.infer<typeof WhatsAppAdminTenantParamsSchema>;
export type WhatsAppAdminBusinessAccountParams = z.infer<
  typeof WhatsAppAdminBusinessAccountParamsSchema
>;
export type ConnectedWhatsAppBusinessAccountResponse = z.infer<
  typeof ConnectedWhatsAppBusinessAccountResponseSchema
>;
export type SyncMessageTemplatesResponse = z.infer<typeof SyncMessageTemplatesResponseSchema>;
export type MessageTemplateListQuery = z.infer<typeof MessageTemplateListQuerySchema>;
export type MessageTemplatePage = z.infer<typeof MessageTemplatePageSchema>;
