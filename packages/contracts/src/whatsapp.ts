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

/**
 * Whether a number may **send**, which registration is what decides.
 *
 * A deliberate second axis to `WhatsAppAccountStatusSchema`: a number can be
 * `connected` (attached, receiving inbound messages) and `unregistered` (unable
 * to send a single one) at the same time, and one enum cannot say that. Cloud
 * API requires `POST /{phone-number-id}/register` before a number may send, and
 * a number that never got it receives normally and refuses every send — the
 * silent-inbox failure this axis exists to make visible (TAR-170, 0002
 * amendment 12).
 *
 *   * `unregistered` — never attempted. Every number connected before this
 *     shipped, and every number attached through the operator paste-token path.
 *   * `pending` — an attempt is in flight, or one died without an answer.
 *   * `registered` — Meta accepted it. The number may send.
 *   * `failed` — Meta answered and refused. `registrationFailureReason` says why.
 *
 * `unregistered` and `failed` are kept apart because the default for a
 * pre-existing row must not read as a Meta rejection that never happened, and
 * the console's copy for the two differs: "set up sending" against "sending
 * failed: …".
 */
export const WHATSAPP_REGISTRATION_STATUSES = [
  'unregistered',
  'pending',
  'registered',
  'failed',
] as const;
export const WhatsAppRegistrationStatusSchema = z.enum(WHATSAPP_REGISTRATION_STATUSES);

/**
 * Why the last registration attempt did not leave the number able to send.
 *
 * Published here rather than in `error-codes.ts` because these travel in a
 * resource body, not in an error envelope: a failed registration answers `200`
 * on both the connect route and the retry route, carrying the outcome as a
 * field. One vocabulary, one parser, and the same six strings whether the
 * failure happened on the first attempt or on a retry (0002, amendment 12).
 *
 * A value read back from storage that this build does not recognise is reported
 * as `rejected` — the same fail-honest rule the Meta client applies to statuses
 * it does not model, and what makes a rollback across an addition here safe.
 */
export const WHATSAPP_REGISTRATION_FAILURE_REASONS = [
  /** Registered already, by us or elsewhere. Nothing to do, or a support conversation. */
  'already_registered',
  /** Meta refused the PIN — the number carries a two-step-verification PIN we do not hold. */
  'pin_rejected',
  /** The stored access token is expired, revoked, or lacks the permission. Re-connect the WABA. */
  'credential_rejected',
  /** Meta is throttling us. The number is unchanged; retry later. */
  'rate_limited',
  /** Meta did not answer usefully — timeout, 5xx, unparseable body. Retry later. */
  'upstream_unavailable',
  /** Meta answered and refused for a reason this build does not model. */
  'rejected',
] as const;
export const WhatsAppRegistrationFailureReasonSchema = z.enum(
  WHATSAPP_REGISTRATION_FAILURE_REASONS,
);

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
  /**
   * Whether this number may send, and why not when it may not. Four fields
   * rather than one because "never attempted" and "Meta refused, here is the
   * reason, at this time" are different facts and the console acts on each of
   * them differently (0002, amendment 12).
   *
   * **No PIN field, here or anywhere.** The registration PIN is a credential of
   * the same class as the access token: encrypted at rest, read back only to
   * re-register, and published by nothing. `contract.test.ts` asserts it.
   */
  registrationStatus: WhatsAppRegistrationStatusSchema,
  registrationFailureReason: WhatsAppRegistrationFailureReasonSchema.nullable(),
  /** When Meta last accepted this number. Set on every success, never cleared. */
  registeredAt: TimestampSchema.nullable(),
  /** When an attempt last started, successful or not. */
  registrationAttemptedAt: TimestampSchema.nullable(),
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
 * What a template's header expects, if it has one. Meta's own `format` values,
 * lower-cased to match the conventions of every other enum published here.
 */
export const MESSAGE_TEMPLATE_HEADER_FORMATS = [
  'text',
  'image',
  'video',
  'document',
  'location',
] as const;
export const MessageTemplateHeaderFormatSchema = z.enum(MESSAGE_TEMPLATE_HEADER_FORMATS);

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
  /**
   * The BODY component's text with `{{n}}` placeholders intact, for the
   * composer's preview. Null when Meta sent no BODY.
   *
   * Derived server-side from `components` (0002, amendment 1). The three derived
   * fields exist because `SendTemplateInputSchema.variables` is a *positional*
   * array: with the component tree as the only source, every consumer — the
   * composer, the chatbot, the workflow builder — would walk Meta's tree itself
   * in an unversioned client-side parser, and the send path could not check
   * arity before calling Meta.
   */
  bodyText: z.string().nullable(),
  /** Highest `{{n}}` in BODY — exactly the length `SendTemplateInput.variables` must have. */
  parameterCount: z.int().nonnegative(),
  /** What the header expects, if the template has one. */
  headerFormat: MessageTemplateHeaderFormatSchema.nullable(),
  /**
   * Placeholders in a `text` header, and `0` for every other format. Counted
   * apart from `parameterCount` rather than folded into one total: the two are
   * supplied through different slots of `SendTemplateInput`, and a single number
   * could not say which.
   */
  headerParameterCount: z.int().nonnegative(),
  /**
   * Whether any button needs a parameter in the send call — a dynamic URL
   * suffix, a quick-reply payload. Those templates are out of scope for v1, so
   * this list drops them and the field is `false` on every row it returns. It is
   * published rather than kept internal because the administration surface has
   * to be able to say "approved by Meta, not yet sendable from this product",
   * and it cannot say that about a template it cannot identify.
   */
  requiresButtonParameters: z.boolean(),
  /** Meta's id for the template, once it has issued one. */
  providerTemplateId: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/**
 * A template's approved body with its positional placeholders filled in.
 *
 * Two callers have to agree on this and cannot be allowed to drift: the send
 * path stores the result on the message row as `body`, so the thread shows what
 * was actually sent, and the composer renders the same string as a preview
 * *before* the send. A second implementation in the console would mean an agent
 * approving one sentence and the customer receiving another.
 *
 * Neither is the source of truth. Meta renders the real thing from its own
 * approved copy; this is a local reproduction, and if the two ever disagree,
 * Meta's is what the customer saw.
 *
 * `null` when the template publishes no body text, which leaves the thread
 * showing a template message with no preview rather than an invented one.
 */
export function renderTemplateBody(
  bodyText: string | null,
  variables: readonly string[],
): string | null {
  if (bodyText === null) {
    return null;
  }

  // `{{1}}` is the first variable. A placeholder with no matching variable is
  // left as it is rather than blanked: the send path's arity check has already
  // made that unreachable, and silently swallowing the marker would hide a
  // future regression in it.
  return bodyText.replaceAll(/\{\{\s*(\d+)\s*\}\}/g, (marker, index: string) => {
    return variables[Number(index) - 1] ?? marker;
  });
}

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

// ---------------------------------------------------------------------------
// Connecting a WABA — the tenant surface (TAR-161, 0002 amendment 2)
// ---------------------------------------------------------------------------

/**
 * Meta's exchangeable token code, as Embedded Signup hands it to the browser.
 *
 * Bounded only. Meta does not publish the code's format, and this is the one
 * credential in the flow that cannot be re-requested — a floor guessed too high
 * would reject a valid code on a request the caller cannot retry, because the
 * code is spent either way. The ceiling is a denial-of-service guard on a body
 * that reaches an unauthenticated-until-stage-3 route, not a claim about length.
 */
const MetaExchangeableTokenCodeSchema = z.string().min(1).max(1024);

/**
 * `POST /api/v1/whatsapp/business-accounts` — a tenant connects its own WABA
 * from the console, having just completed Meta's Embedded Signup.
 *
 * **This is not `ConnectWhatsAppBusinessAccountInputSchema` with a different
 * credential.** That one stays the operator input on
 * `POST /api/v1/admin/tenants/{slug}/whatsapp/business-accounts`, reached
 * through `PlatformAdminGuard`, and keeps its pasted `accessToken`. Two schemas
 * rather than one union with an either-`code`-or-`accessToken` refinement: they
 * are different credentials, arriving from different principals through
 * different guards, and collapsing them would put "a pasted token is acceptable
 * here" one boolean away from a tenant-facing route (0002, amendment 2).
 *
 * **`accessToken` does not appear, and no tenant-facing schema in this file ever
 * will.** The browser never holds a WABA token: Embedded Signup gives it a code,
 * the code comes to us, and the exchange is server-to-server with the app
 * secret — which is the whole reason the flow returns a code and not a token.
 *
 * **The code lives about 30 seconds**, which shapes the endpoint rather than
 * only the schema: the exchange happens inside the request, the `POST` takes no
 * `Idempotency-Key` and is not retryable — a replay replays a spent code — and
 * the retry unit is the *flow*, which the console re-runs for a fresh code. The
 * underlying connection stays idempotent on `wabaId`, which is also how a tenant
 * rotates a credential Meta has invalidated.
 *
 * The response is `ConnectedWhatsAppBusinessAccountResponseSchema`, unchanged:
 * both paths connect the same thing and an operator and a tenant admin have the
 * same next question — did every number land.
 */
export const WhatsAppEmbeddedSignupInputSchema = z.object({
  /** Meta's exchangeable token code, straight from the browser's `FINISH` event. */
  code: MetaExchangeableTokenCodeSchema,
  /**
   * What Embedded Signup told the browser it granted — an assertion, not an
   * authority. The browser does not decide which WABA a token covers, so the
   * server exchanges the code and reads this WABA back *with the token it just
   * received*; a token that cannot read it ends the request with
   * `whatsapp_signup_failed` / `waba_mismatch` and leaves no row behind.
   */
  wabaId: MetaWabaIdSchema,
  /**
   * A hint, and optional for that reason. The numbers that actually get attached
   * are read from Meta on the new token: `displayPhoneNumber`, `verifiedName`
   * and the WABA's own name and verification status are fields the connection
   * requires and the browser does not have, so there is one authority for what
   * was connected and it is the one that issued the token.
   */
  phoneNumberId: MetaPhoneNumberIdSchema.optional(),
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

/** Names one connected phone number by **our** id — never Meta's. */
export const WhatsAppPhoneNumberParamsSchema = z.object({
  whatsappAccountId: IdSchema,
});

/**
 * `POST /api/v1/whatsapp/phone-numbers/{whatsappAccountId}/registration` — try
 * registering this number for sending again (TAR-170, 0002 amendment 12).
 *
 * The id is the one the connect response already published as `accounts[].id`,
 * not Meta's `phone_number_id`: tenant isolation makes another tenant's id
 * indistinguishable from absent, so it answers `not_found` rather than
 * `forbidden`. It is not nested under the WABA, because a number names exactly
 * one business account and the send path already resolves it that way.
 *
 * No request body, and no `Idempotency-Key`. Unlike the connect endpoint there
 * is no spent code to protect, and the operation is idempotent by construction:
 * the same stored PIN, the same Meta call, and a number that already reads
 * `registered` short-circuits before Meta is touched.
 *
 * ## A registration failure answers 200
 *
 * Not `4xx`/`5xx`. The call did what it was asked — it attempted registration
 * and recorded the outcome — and the outcome rides in
 * `registrationFailureReason`. This is forced rather than stylistic: on the
 * first attempt the failure *cannot* be an error envelope, because the
 * connection succeeded and the response is the connection. Using one here would
 * make the console parse the same fact two ways. `rate_limited` and
 * `upstream_unavailable` therefore appear as reasons in a `200` body rather
 * than as the platform error codes of the same name — a deliberate departure,
 * confined to this field.
 *
 * Genuine errors are still errors: `not_found` for an id that names nothing
 * reachable, `forbidden` without `channel:manage`, `tenant_inactive` for a
 * deactivated tenant.
 */
export const WhatsAppPhoneNumberRegistrationResponseSchema = z.object({
  whatsappAccountId: IdSchema,
  phoneNumberId: MetaPhoneNumberIdSchema,
  registrationStatus: WhatsAppRegistrationStatusSchema,
  registrationFailureReason: WhatsAppRegistrationFailureReasonSchema.nullable(),
  registeredAt: TimestampSchema.nullable(),
  registrationAttemptedAt: TimestampSchema.nullable(),
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
 * **Sendable only, on the same reasoning.** Templates whose buttons take a
 * parameter — a dynamic URL suffix, a quick-reply payload — are out of scope for
 * v1 and are excluded here too, because nothing in TAR-20 designs the composer
 * UX to fill one, so listing them would offer a send that cannot be completed.
 * They remain visible on the administration surface, where "approved by Meta,
 * not yet sendable from this product" is a state a supervisor can be shown.
 * Because the exclusion is a property of Meta's component tree rather than a
 * column, it is applied to the page after it is read: a page may therefore hold
 * fewer than `limit` items while `nextCursor` is non-null, and a caller reads to
 * the end of the feed by paging until `nextCursor` is null — never by counting.
 *
 * **The composer filters by phone number, not by business account.**
 * `ConversationResponseSchema` publishes `whatsappAccountId` — a number — and
 * nothing maps one to a WABA, so asking the composer for a WABA would make it
 * either list unfiltered, offering templates that cannot be sent on that number,
 * or block on a lookup that does not exist. The server resolves the WABA from
 * the number, exactly as the send path already does for
 * `SendTemplateInputSchema`. `whatsappBusinessAccountId` remains for the
 * cross-number administrative read; at most one of the two (0002, amendment 1).
 *
 * Results are ordered `name ASC, language ASC, id ASC`: an agent scans this
 * picker looking for `order_update`, not for whatever Meta approved most
 * recently, and a name-leading order is what makes `q` a prefix range rather
 * than a filter over an already-fetched page.
 */
export const MessageTemplateListQuerySchema = CursorPageQuerySchema.extend({
  /** A phone number. The server resolves its WABA — the caller does not hold one. */
  whatsappAccountId: IdSchema.optional(),
  /** Cross-number administrative read. Mutually exclusive with the above. */
  whatsappBusinessAccountId: IdSchema.optional(),
  /** Name prefix. Free once the index leads with `name`. */
  q: z.string().min(1).max(120).optional(),
}).refine(
  (query) => !(query.whatsappAccountId && query.whatsappBusinessAccountId),
  'Provide at most one of whatsappAccountId or whatsappBusinessAccountId',
);

/** `{ items, nextCursor }` per TAR-39's list convention — no envelope. */
export const MessageTemplatePageSchema = z.object({
  items: z.array(MessageTemplateResponseSchema),
  nextCursor: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Template administration — the `channel:manage` surface (TAR-91, 0002 amendment 8)
// ---------------------------------------------------------------------------

/**
 * Why a template the tenant holds is not in the composer's picker.
 *
 * `MessageTemplateListQuerySchema` drops rows on exactly two rules, and this
 * vocabulary is those two rules named. That is the whole point of the surface:
 * amendment 1 accepts both exclusions on the promise that they are *visible*
 * somewhere, and a template that is simply absent from one list and present in
 * another explains nothing.
 *
 *   * `meta_not_approved` — Meta has not approved it (`pending`), or has
 *     withdrawn approval (`rejected`, `paused`, `disabled`). Nothing the product
 *     can do; the template is fixed in Meta's own tooling.
 *   * `button_parameters_required` — Meta *has* approved it, and this build
 *     cannot fill what its buttons need at send time. A product limit, not
 *     Meta's, which is exactly the distinction an administrator needs in order
 *     to know whether to wait for Meta or to raise it with us.
 *
 * A row may carry both: a pending template with a dynamic-URL button is blocked
 * twice, and reporting one of them would leave an administrator watching for a
 * Meta approval that will not put the template in the picker.
 *
 * The set may grow — a future exclusion is a new member here rather than a
 * silent absence — so a client renders an unrecognised value as "not sendable"
 * rather than assuming this list is closed.
 */
export const MESSAGE_TEMPLATE_SEND_BLOCKERS = [
  'meta_not_approved',
  'button_parameters_required',
] as const;
export const MessageTemplateSendBlockerSchema = z.enum(MESSAGE_TEMPLATE_SEND_BLOCKERS);

/**
 * A template as the administration surface shows it: the published resource,
 * plus whether an agent can actually send it and what stands in the way.
 *
 * Built by extending `MessageTemplateResponseSchema` rather than restating it,
 * so a field added to a template cannot be forgotten here — and so the two
 * surfaces cannot describe the same row differently. `requiresButtonParameters`
 * is inherited and stays exactly what it was; `sendBlockers` is the answer to
 * the question that field alone could not answer, because a template can also be
 * missing for a reason that has nothing to do with its buttons.
 *
 * `sendable` is derivable from `sendBlockers` and is published anyway: it is the
 * question a client actually asks, and leaving every consumer to write
 * `blockers.length === 0` makes the emptiness convention an unwritten rule. The
 * refinement below is what keeps the redundancy safe — the two can never
 * disagree, in either direction, and a response that got it wrong fails to parse
 * rather than misreporting a template as sendable.
 */
export const MessageTemplateAdminResponseSchema = MessageTemplateResponseSchema.extend({
  sendable: z.boolean(),
  sendBlockers: z.array(MessageTemplateSendBlockerSchema),
}).refine(
  (template) => template.sendable === (template.sendBlockers.length === 0),
  'sendable must mean exactly that sendBlockers is empty',
);

/**
 * `GET /api/v1/whatsapp/message-templates` — every template this tenant holds,
 * whatever Meta thinks of it (TAR-91; ruled in 0002 amendment 8).
 *
 * **A separate route, not a widening of `GET /api/v1/message-templates`.**
 * Amendment 1 fixes the approved-and-sendable filter in that route with no
 * parameter that can reach past it, precisely so a picker cannot offer a send
 * that fails at Meta. Administration needs the opposite default, so it gets its
 * own path, its own permission and its own response — the one arrangement in
 * which neither surface can be turned into the other by a query string.
 *
 * **`channel:manage`, not `conversation:send`.** This is the WhatsApp channel's
 * configuration, next to the WABA connection under the same permission. An agent
 * who may send does not thereby need to see a rejected template, and the reverse
 * is what the surface exists for.
 *
 * **Filters by WABA, not by phone number.** Templates are approved per WABA;
 * every number behind one shares them, so a number filter would be a longer way
 * of naming the same set. Amendment 1 already reserves
 * `whatsappBusinessAccountId` for exactly this "cross-number administrative
 * read", and an administrator holds a WABA — it is what they connected.
 *
 * **`status` is a filter here, and only here.** The reason it is refused on the
 * composer's route is that it would make an unsendable template reachable from a
 * picker; on a surface whose purpose is showing unapproved templates there is
 * nothing to protect. It narrows within what the caller may already see rather
 * than widening it.
 *
 * Ordering is amendment 1's, unchanged — `name ASC, language ASC, id ASC` — so
 * the two lists put the same template in the same place and an administrator
 * comparing them is not also reconciling two sort orders.
 */
export const MessageTemplateAdminListQuerySchema = CursorPageQuerySchema.extend({
  /** One connected business account. Omitted, the page spans every WABA the tenant holds. */
  whatsappBusinessAccountId: IdSchema.optional(),
  /** Meta's approval status. Narrows what is shown; it can never widen it. */
  status: MessageTemplateStatusSchema.optional(),
  /** Name prefix, as on the composer's list. */
  q: z.string().min(1).max(120).optional(),
});

/** `{ items, nextCursor }` per TAR-39's list convention — no envelope. */
export const MessageTemplateAdminPageSchema = z.object({
  items: z.array(MessageTemplateAdminResponseSchema),
  nextCursor: z.string().nullable(),
});

export type WhatsAppBusinessVerificationStatus = z.infer<
  typeof WhatsAppBusinessVerificationStatusSchema
>;
export type WhatsAppBusinessAccountResponse = z.infer<typeof WhatsAppBusinessAccountResponseSchema>;
export type WhatsAppQualityRating = z.infer<typeof WhatsAppQualityRatingSchema>;
export type WhatsAppAccountStatus = z.infer<typeof WhatsAppAccountStatusSchema>;
export type WhatsAppRegistrationStatus = z.infer<typeof WhatsAppRegistrationStatusSchema>;
export type WhatsAppRegistrationFailureReason = z.infer<
  typeof WhatsAppRegistrationFailureReasonSchema
>;
export type WhatsAppPhoneNumberParams = z.infer<typeof WhatsAppPhoneNumberParamsSchema>;
export type WhatsAppPhoneNumberRegistrationResponse = z.infer<
  typeof WhatsAppPhoneNumberRegistrationResponseSchema
>;
export type WhatsAppAccountResponse = z.infer<typeof WhatsAppAccountResponseSchema>;
export type MessageTemplateStatus = z.infer<typeof MessageTemplateStatusSchema>;
export type MessageTemplateHeaderFormat = z.infer<typeof MessageTemplateHeaderFormatSchema>;
export type MessageTemplateResponse = z.infer<typeof MessageTemplateResponseSchema>;

export type ConnectWhatsAppPhoneNumberInput = z.infer<typeof ConnectWhatsAppPhoneNumberInputSchema>;
export type ConnectWhatsAppBusinessAccountInput = z.infer<
  typeof ConnectWhatsAppBusinessAccountInputSchema
>;
export type WhatsAppEmbeddedSignupInput = z.infer<typeof WhatsAppEmbeddedSignupInputSchema>;
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

export type MessageTemplateSendBlocker = z.infer<typeof MessageTemplateSendBlockerSchema>;
export type MessageTemplateAdminResponse = z.infer<typeof MessageTemplateAdminResponseSchema>;
export type MessageTemplateAdminListQuery = z.infer<typeof MessageTemplateAdminListQuerySchema>;
export type MessageTemplateAdminPage = z.infer<typeof MessageTemplateAdminPageSchema>;

// ---------------------------------------------------------------------------
// What the console needs to launch Embedded Signup (TAR-816)
// ---------------------------------------------------------------------------

/**
 * `GET /api/v1/whatsapp/embedded-signup/config` — the two Meta ids and the
 * Graph API version the console's `FB.login` call needs, served from the API's
 * runtime configuration.
 *
 * ## Why this endpoint exists at all
 *
 * The console used to read `NEXT_PUBLIC_META_APP_ID` and
 * `NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID`, which Next.js inlines into the
 * browser bundle **at build time**. TAR-816 makes the API's copy of those two
 * values operator-editable at runtime; without this endpoint that would be a
 * setting which appears to save and changes nothing, because the browser would
 * still be holding whatever was compiled in on the last deploy. Both variables
 * are gone, and this is what replaced them.
 *
 * ## Why it is safe to publish
 *
 * Neither value is a secret. Both already reach every browser today, by design:
 * the app id is what `FB.login` is called with and the configuration id names a
 * public Facebook Login for Business configuration. What completes the exchange
 * is `WHATSAPP_APP_SECRET`, which is a `secret` key in the platform-settings
 * registry, never leaves the API, and has no representation in this file.
 *
 * The route is session-authenticated and permissioned like the connect call
 * beside it rather than public — not because the values need protecting, but
 * because an anonymous endpoint that reports how this platform's Meta app is
 * configured is a free reconnaissance surface for no gain.
 *
 * `null` means unconfigured, and the console must render that as "WhatsApp
 * connection is not available in this environment" rather than calling
 * `FB.login` with `undefined`.
 */
export const WhatsAppEmbeddedSignupConfigResponseSchema = z.object({
  /** `client_id` for `FB.login`. Null when neither the database nor the environment holds one. */
  appId: MetaGraphIdSchema.nullable(),
  /** The Facebook Login for Business configuration the console launches. */
  configId: MetaGraphIdSchema.nullable(),
  /**
   * The Graph API version the console's SDK should load, so browser and server
   * agree on one pin. Not operator-managed: a wrong value breaks every send at
   * once, and the pin is deliberate (0002; TAR-811 flags it as higher-risk than
   * it looks).
   */
  graphApiVersion: z.string().regex(/^v\d+\.\d+$/, 'Must look like `v23.0`'),
});

export type WhatsAppEmbeddedSignupConfigResponse = z.infer<
  typeof WhatsAppEmbeddedSignupConfigResponseSchema
>;
