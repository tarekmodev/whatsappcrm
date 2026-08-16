import { z } from 'zod';
import { PlanSchema } from './billing';
import { HexColorSchema, IdSchema, TimestampSchema, type IanaTimezone } from './common';

/**
 * Tenant identity, lifecycle and branding. TAR-19 provisions tenants, TAR-36
 * drives the lifecycle, TAR-29 fills in branding.
 */

/**
 * The tenant lifecycle is **ours**, not the billing provider's. Polar events are
 * inputs to this state machine (see `billing.ts`); a provider status is never
 * stored as the tenant's status directly. That is what keeps a provider swap
 * from touching lifecycle logic.
 */
export const TENANT_STATUSES = [
  /**
   * The row exists and nothing else does. It is the column default and the
   * fail-closed state of a tenant written by anything other than
   * `TenantProvisioningService` — a fixture, a half-applied migration, a
   * provisioning path that is not one transaction. No tenant is ever *served*
   * in it: provisioning and signup both leave it inside the transaction that
   * created the row, which is what makes the gates refusing it meaningful
   * rather than a state customers see (0009, decision 1).
   */
  'created',
  'trialing',
  'active',
  'past_due',
  'suspended',
  'cancelled',
  'deleted',
] as const;

export const TenantStatusSchema = z.enum(TENANT_STATUSES);
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/**
 * Legal transitions, and exactly the edges in 0009's state diagram. Anything
 * absent here is a bug, and the transition function in `apps/api` throws rather
 * than silently allowing it — a tenant that goes `deleted → active` is a
 * data-retention incident, not a state change.
 *
 * Two edges changed when 0009 fixed the graph, and both are load-bearing:
 *
 *   * **`cancelled → deleted` is gone; `suspended → deleted` replaces it.**
 *     Everything funnels through `suspended` before `deleted`, because `purge_at`
 *     is set on entry to `suspended` and nowhere else. One timer, one sweep
 *     branch, one code path that can destroy data — a second road to `deleted`
 *     would be a second deletion path with its own clock.
 *   * **`cancelled → suspended` is new**, and is what the cancellation grace
 *     period elapsing does.
 */
export const TENANT_STATUS_TRANSITIONS: Record<TenantStatus, readonly TenantStatus[]> = {
  // Provisioning commits `trialing` for self-signup and `active` for an
  // operator-provisioned tenant, both inside the transaction that inserts the row.
  created: ['trialing', 'active'],
  trialing: ['active', 'past_due', 'cancelled', 'suspended'],
  active: ['past_due', 'cancelled', 'suspended'],
  past_due: ['active', 'suspended', 'cancelled'],
  suspended: ['active', 'cancelled', 'deleted'],
  cancelled: ['active', 'suspended'],
  deleted: [],
};

export function canTransitionTenant(from: TenantStatus, to: TenantStatus): boolean {
  return TENANT_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * What each status means operationally. `past_due` and `suspended` differ on
 * exactly one axis — whether agents may still reply — and getting that wrong
 * either loses a customer's messages or gives away the product, so it is stated
 * here rather than rediscovered per feature.
 *
 * Note that `inboundAccepted` stays true through `suspended`: refusing Meta's
 * webhook would make Meta retry and then drop real customer messages. We keep
 * accepting and persisting them; we just do not let the tenant answer. This is
 * the property `assert_tenant_serviceable` admits `suspended` for — the ingest
 * path writes `conversations` and `messages` through `TenantPrisma`, so a
 * database gate that refused a suspended tenant would force the highest-volume
 * write in the product onto the unscoped client (0009, decision 2).
 *
 * `apiAccess` is about **agent and admin HTTP access**, not about whether a
 * statement may touch the tenant's rows. The two are separate questions with
 * separate gates, and `suspended` is exactly where they diverge: no console
 * access, but the webhook still lands.
 */
export const TENANT_STATUS_EFFECTS: Record<
  TenantStatus,
  { apiAccess: boolean; inboundAccepted: boolean; outboundAllowed: boolean }
> = {
  // Never observable: provisioning leaves this state inside the transaction that
  // created the row, and `HostTenantGuard` answers `tenant_not_found` for it.
  created: { apiAccess: false, inboundAccepted: false, outboundAllowed: false },
  trialing: { apiAccess: true, inboundAccepted: true, outboundAllowed: true },
  active: { apiAccess: true, inboundAccepted: true, outboundAllowed: true },
  // Fully operational — dunning is a billing banner, not an outage.
  past_due: { apiAccess: true, inboundAccepted: true, outboundAllowed: true },
  // `apiAccess: false` is TAR-36's fourth acceptance criterion — agents cannot
  // log in. An admin keeps a narrow way back in through the routes marked
  // `@AvailableWhileSuspended()`, so a suspended tenant is not one that cannot
  // pay its way out; that allowlist is the guard's business, not this table's.
  suspended: { apiAccess: false, inboundAccepted: true, outboundAllowed: false },
  cancelled: { apiAccess: false, inboundAccepted: false, outboundAllowed: false },
  deleted: { apiAccess: false, inboundAccepted: false, outboundAllowed: false },
};

/**
 * What moved a tenant between states. Every edge in the state machine is caused
 * by exactly one of these, and `TenantLifecycleService` refuses an edge whose
 * trigger is not the one recorded for it: `active → past_due` from a UI button
 * is a bug, not a shortcut (0009, proposed architecture).
 */
export const LIFECYCLE_TRIGGERS = [
  /** A tenant admin pressed something — cancel, undo cancel, request deletion. */
  'user_action',
  /** A platform operator acted through the admin API, holding `PLATFORM_ADMIN_TOKEN`. */
  'operator_action',
  /** A normalised `BillingEvent` arrived. TAR-37 produces these; the union is fixed today. */
  'billing_event',
  /** The lifecycle sweep found an elapsed `trial_ends_at`, `grace_period_ends_at` or `purge_at`. */
  'timer',
  /** The platform itself, with no actor — provisioning writing a tenant's first row. */
  'system',
] as const;

export const LifecycleTriggerSchema = z.enum(LIFECYCLE_TRIGGERS);
export type LifecycleTrigger = (typeof LIFECYCLE_TRIGGERS)[number];

/**
 * Who is recorded against a lifecycle transition. Mirrors the `audit_actor_type`
 * database enum so `lifecycle_events` and `audit_logs` describe an actor the
 * same way, and so a reader does not have to learn two vocabularies.
 *
 * `unattributed` is here because the backfill migration writes it for the state
 * each tenant was already in when the table was created. Application code never
 * writes it — `AuditActor` in `apps/api` excludes it.
 */
export const LIFECYCLE_ACTOR_TYPES = [
  'user',
  'platform_operator',
  'system',
  'unattributed',
] as const;

export const LifecycleActorTypeSchema = z.enum(LIFECYCLE_ACTOR_TYPES);
export type LifecycleActorType = (typeof LIFECYCLE_ACTOR_TYPES)[number];

/**
 * Every window in the lifecycle, in one object, on `AUTH_POLICY`'s precedent:
 * one place to read them and one place to change them.
 *
 * These are **lengths, not instants**. The database stores only the instants the
 * sweep compares against, so revising a value here changes when future timers
 * fire and cannot silently reinterpret one already running for a live tenant.
 *
 * Defensible starting values rather than measured ones, except where noted.
 */
export const LIFECYCLE_POLICY = Object.freeze({
  /** Long enough to connect a WABA and run real conversations through it. Two weekends. */
  trialDays: 14,
  /**
   * A card retry cycle. A provider retries a failed charge over roughly this
   * window, so suspending sooner suspends tenants whose payment was going to
   * succeed anyway.
   */
  pastDueGraceDays: 14,
  /** An accidental or regretted cancellation is discovered within a week. */
  cancelledGraceDays: 7,
  /**
   * TAR-18's stated default, recorded there as "pending client policy". The one
   * value here that is a policy decision rather than an engineering one, and the
   * only one that is irreversible in the wrong direction — 0009's open question 1
   * asks for it to be confirmed before the lifecycle engine ships.
   */
  purgeAfterSuspendedDays: 30,
  /** One email before the point of no return, while there is still time to act. */
  deletionReminderDays: 7,
  trialEndingReminderDays: 3,
  /**
   * Longer than `passwordResetTtlMs`, shorter than `inviteTtlMs`: the person is
   * at the keyboard now, but they may check that mailbox tomorrow.
   */
  signupTokenTtlMs: 24 * 60 * 60 * 1000,
} as const);

/**
 * One row of a tenant's lifecycle history, as `GET /api/v1/tenant/lifecycle/events`
 * and its operator twin return it.
 *
 * `metadata` is deliberately absent from the response even though the column
 * carries it: it holds a provider event id or an elapsed-timer measurement, which
 * are platform forensics rather than something a tenant admin needs. `reason` is
 * absent for the same reason — it is operator free text and 0009 says it is never
 * rendered to the tenant.
 */
export const TenantLifecycleEventSchema = z.object({
  id: IdSchema,
  /** Null only for the first row of a tenant's life. */
  fromStatus: TenantStatusSchema.nullable(),
  toStatus: TenantStatusSchema,
  trigger: LifecycleTriggerSchema,
  actorType: LifecycleActorTypeSchema,
  /** The operator credential label, or the admin's email at the time. */
  actorLabel: z.string().nullable(),
  occurredAt: TimestampSchema,
});

/*
 * `TenantLifecycleResponseSchema` — the shape of `GET /api/v1/tenant/lifecycle` —
 * is **not** declared here. TAR-409 publishes it, because TAR-409 is what renders
 * it, and its version carries the `plan` and `usage` fields 0009 specifies that
 * this story has no reader for. An earlier revision of this file declared a
 * narrower second copy; two declarations of one identifier in one module is a
 * build failure, and two shapes for one endpoint is worse than that. The engine
 * imports the published one.
 */

// ---------------------------------------------------------------------------
// Branding — TAR-29
// ---------------------------------------------------------------------------

export const BRANDING_ASSET_KINDS = ['logo', 'favicon'] as const;
export const BrandingAssetKindSchema = z.enum(BRANDING_ASSET_KINDS);
export type BrandingAssetKind = (typeof BRANDING_ASSET_KINDS)[number];

/**
 * Published here rather than kept in the API so the settings UI can refuse a
 * 4 MB PNG before spending the upload. The server enforces the same numbers, and
 * sniffs the bytes rather than trusting the declared `Content-Type`.
 *
 * No `image/svg+xml`, deliberately: an SVG served same-origin executes script,
 * and a sanitiser is a security dependency to own forever. PNG, JPEG and WebP
 * cover the requirement.
 */
export const BRANDING_ASSET_LIMITS: Readonly<
  Record<BrandingAssetKind, { readonly maxBytes: number; readonly mimeTypes: readonly string[] }>
> = {
  logo: { maxBytes: 512 * 1024, mimeTypes: ['image/png', 'image/jpeg', 'image/webp'] },
  favicon: { maxBytes: 64 * 1024, mimeTypes: ['image/png', 'image/x-icon'] },
};

/** The multipart field both tiers agree on, as `MEDIA_UPLOAD_FIELD` does. */
export const BRANDING_UPLOAD_FIELD = 'file';

export const BrandingAssetSchema = z.object({
  /**
   * Relative, host-agnostic and cache-busted. **Not** an absolute URL: the same
   * row is served under a platform subdomain *and* under a custom domain, so a
   * stored absolute URL would name whichever host existed at write time and make
   * the browser fetch it cross-origin — the exact thing the first-party cookie
   * rule forbids. Same precedent as `MediaObjectResponse.contentPath`.
   */
  path: z.string(),
  mimeType: z.string(),
  sizeBytes: z.int().nonnegative(),
  updatedAt: TimestampSchema,
});

/** The one place these routes are spelled, so the API and the web app agree. */
export function brandingAssetPath(kind: BrandingAssetKind, updatedAt: Date): string {
  return `/api/v1/tenant/branding/${kind}?v=${updatedAt.getTime()}`;
}

/** Per-tenant white-label appearance. TAR-29 owns the editor; the shape is fixed here. */
export const TenantBrandingSchema = z.object({
  productName: z.string().min(1).max(60),
  primaryColor: HexColorSchema,
  accentColor: HexColorSchema,
  supportEmail: z.email().nullable(),
  logo: BrandingAssetSchema.nullable(),
  favicon: BrandingAssetSchema.nullable(),
});

/**
 * What the API substitutes for an absent row or an unset column, so the response
 * is **always fully populated** and the frontend renders unconditionally.
 *
 * Defaults live here rather than as `NOT NULL DEFAULT` in the database: a column
 * default would bake the platform's brand into every tenant's row and make "has
 * this tenant customised anything" unanswerable. `PLATFORM_PRODUCT_NAME`
 * overrides the product name per deployment.
 */
export const BRANDING_DEFAULTS = {
  productName: 'WhatsApp CRM',
  primaryColor: '#067a52', // green-600, the platform accent
  accentColor: '#2e4a63', // navy-700
} as const;

/** Assets are set by their own routes; `PATCH /tenant` never carries bytes. */
export const BrandingUpdateInputSchema = z.object({
  productName: z.string().min(1).max(60).optional(),
  primaryColor: HexColorSchema.optional(),
  accentColor: HexColorSchema.optional(),
  supportEmail: z.email().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Custom domains — TAR-29
// ---------------------------------------------------------------------------

/**
 * `platform`, not `platform_subdomain`: the wire value is the database enum value
 * (`TenantDomainKind` in `schema.prisma`), so no mapping layer exists to drift.
 */
export const TENANT_DOMAIN_KINDS = ['platform', 'custom'] as const;
export const TenantDomainKindSchema = z.enum(TENANT_DOMAIN_KINDS);
export type TenantDomainKind = (typeof TENANT_DOMAIN_KINDS)[number];

/**
 * Derived from the row, never stored — a stored status is a second source of
 * truth that disagrees with its own columns after one failed write.
 *
 *   pending_verification  token issued, TXT not seen yet
 *   verified              ownership proved; resolves, but the edge may not route it
 *   live                  attached at the edge with a certificate
 *   expired               unverified past the window; the sweeper will remove it
 */
export const TENANT_DOMAIN_STATUSES = [
  'pending_verification',
  'verified',
  'live',
  'expired',
] as const;
export const TenantDomainStatusSchema = z.enum(TENANT_DOMAIN_STATUSES);
export type TenantDomainStatus = (typeof TENANT_DOMAIN_STATUSES)[number];

export const DOMAIN_VERIFICATION_FAILURE_REASONS = [
  'record_not_found',
  'record_mismatch',
  'lookup_failed',
  'lookup_timeout',
] as const;
export const DomainVerificationFailureReasonSchema = z.enum(DOMAIN_VERIFICATION_FAILURE_REASONS);
export type DomainVerificationFailureReason = (typeof DOMAIN_VERIFICATION_FAILURE_REASONS)[number];

export const DomainVerificationSchema = z.object({
  recordType: z.literal('TXT'),
  /** `_whatsappcrm-challenge.support.acme.com` */
  recordName: z.string(),
  /** `whatsappcrm-domain-verification=<token>` */
  recordValue: z.string(),
  lastCheckedAt: TimestampSchema.nullable(),
  lastFailureReason: DomainVerificationFailureReasonSchema.nullable(),
  /** When an unverified claim is released for anyone else to take. */
  expiresAt: TimestampSchema,
});

export const DomainRoutingSchema = z.object({
  recordType: z.enum(['CNAME', 'ALIAS', 'A']),
  recordName: z.string(),
  /** The web service's edge hostname, from `PLATFORM_EDGE_HOSTNAME`. */
  recordValue: z.string(),
});

/**
 * A tenant is reachable on one or more hostnames — a platform subdomain always,
 * plus any verified custom domain. Hostname → tenant is the first half of tenant
 * resolution on every request.
 */
export const TenantDomainSchema = z.object({
  id: IdSchema,
  hostname: z.string().min(4).max(253),
  kind: TenantDomainKindSchema,
  status: TenantDomainStatusSchema,
  isPrimary: z.boolean(),
  verifiedAt: TimestampSchema.nullable(),
  activatedAt: TimestampSchema.nullable(),
  /** Null for `kind: 'platform'` — ours to issue, nothing to prove. */
  verification: DomainVerificationSchema.nullable(),
  /** Null for `kind: 'platform'`, and once the domain is `live`. */
  routing: DomainRoutingSchema.nullable(),
  createdAt: TimestampSchema,
});

/** How many custom domains one tenant may hold before `plan_limit_exceeded`. */
export const MAX_CUSTOM_DOMAINS_PER_TENANT = 5;

/**
 * The DNS ownership challenge, spelled once (TAR-420).
 *
 * The console renders these for the tenant to paste and the API compares the
 * resolved TXT record against them, so the two have to agree byte for byte — a
 * label or prefix that drifted on one side is a verification that can never pass
 * and a support ticket nobody can diagnose from either half alone.
 *
 * `DomainVerificationSchema` already carries the rendered strings on the wire;
 * these are what *builds* them, and what the verifier compares against.
 */
export const DOMAIN_CHALLENGE_LABEL = '_whatsappcrm-challenge';

/**
 * The value prefix. Compared in full rather than looking for a bare token, so a
 * hex string somebody happened to publish at the same name cannot satisfy the
 * challenge, and another vendor's token cannot either.
 */
export const DOMAIN_CHALLENGE_VALUE_PREFIX = 'whatsappcrm-domain-verification=';

/** `support.acme.com` → `_whatsappcrm-challenge.support.acme.com`. */
export function domainChallengeRecordName(hostname: string): string {
  return `${DOMAIN_CHALLENGE_LABEL}.${hostname}`;
}

export function domainChallengeRecordValue(token: string): string {
  return `${DOMAIN_CHALLENGE_VALUE_PREFIX}${token}`;
}

/** Labels are 1–63 chars, ASCII letters-digits-hyphen, no leading or trailing hyphen. */
const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
/** Names that resolve inside a network rather than on the public internet. */
const RESERVED_SUFFIXES = ['.local', '.internal', '.localhost'] as const;

/**
 * A hostname a tenant may claim.
 *
 * Punycode (A-label) only, and the refinements are the security half rather than
 * tidiness: non-ASCII is **refused with an explicit message rather than silently
 * converted**, because a homograph accepted quietly is a phishing host we would
 * then issue a certificate for.
 *
 * One rule cannot live here: a hostname under `PLATFORM_DOMAIN` is ours to issue
 * and must never be claimable as custom. That value is server-side configuration
 * and is not published to the browser, so the API applies it on top of this.
 */
export const CustomHostnameInputSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(253)
  .refine((value) => !value.endsWith('.'), 'Leave off the trailing dot')
  .refine((value) => !value.includes(':'), 'Leave off the port')
  .refine((value) => !IPV4_LITERAL.test(value), 'Enter a hostname, not an IP address')
  .refine((value) => value.split('.').length >= 2, 'Enter a full hostname, e.g. support.acme.com')
  .refine(
    (value) =>
      !RESERVED_SUFFIXES.some((suffix) => value === suffix.slice(1) || value.endsWith(suffix)),
    'That name only resolves inside a private network',
  )
  .refine(
    (value) => value.split('.').every((label) => HOSTNAME_LABEL.test(label)),
    'Use letters, digits and hyphens only — an internationalised domain must be entered in its punycode form',
  );

export const TenantDomainCreateInputSchema = z.object({
  hostname: CustomHostnameInputSchema,
});

/**
 * `{id}` on the domain sub-resources — `POST /verify`, `POST /primary`,
 * `DELETE`.
 *
 * It names a **row**, never a tenant. The lookup behind it is scoped by RLS to
 * the tenant the host resolved, so an id belonging to another tenant answers
 * `not_found` — the same answer an id belonging to nobody gets.
 */
export const TenantDomainParamsSchema = z.object({
  id: IdSchema,
});

/**
 * `GET /api/v1/tenant/domains`. A plain `{ items }` envelope rather than a
 * cursor page: the set is capped at `MAX_CUSTOM_DOMAINS_PER_TENANT` plus the
 * platform subdomain, so there is nothing to page.
 */
export const TenantDomainListResponseSchema = z.object({
  items: z.array(TenantDomainSchema),
});

/**
 * Human-readable tenant handle. Immutable once issued: it is baked into the
 * platform subdomain, so changing it would break every bookmark and every
 * session cookie scoped to that host.
 *
 * The pattern forbids a leading or trailing hyphen because the slug becomes a
 * DNS label, and a label may not start or end with one.
 */
export const TenantSlugSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
    'Must be lowercase letters, digits and hyphens, starting and ending with a letter or digit',
  );

export const TenantNameSchema = z.string().min(1).max(120);

export const TenantResponseSchema = z.object({
  id: IdSchema,
  name: TenantNameSchema,
  slug: TenantSlugSchema,
  status: TenantStatusSchema,
  branding: TenantBrandingSchema,
  /**
   * The tenant's hostnames — but **`verification` and `routing` are null unless
   * the caller holds `domain:write`**, which is what `GET /tenant/domains`
   * requires for the same rows.
   *
   * `GET /tenant` is reachable by every signed-in member because the shell needs
   * the workspace name, its colours and the address it answers on. The DNS
   * challenge is a different question, so it is not on this route for a caller
   * who could not read it on the other one. Anything that needs the setup half —
   * the domains settings screen — fetches `/tenant/domains` under its own
   * permission and gets the unabridged rows.
   *
   * Same shape either way, so a client parses one type; what changes is how much
   * of it is populated.
   */
  domains: z.array(TenantDomainSchema),
  trialEndsAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

/**
 * `GET /api/v1/tenant/public` — the only unauthenticated tenant endpoint. The
 * login page needs branding before anyone has a session, so this exposes the
 * minimum an anonymous caller may see and nothing else.
 */
export const TenantPublicResponseSchema = z.object({
  id: IdSchema,
  name: z.string(),
  branding: TenantBrandingSchema,
});

/**
 * `GET /api/v1/tenant/lifecycle` — what the workspace settings page's plan panel
 * renders (0009, TAR-409).
 *
 * Deliberately **not** `BillingSummaryResponse`. That one is TAR-37's and
 * describes a subscription; this describes a lifecycle, and the two coexist —
 * a tenant with no subscription still has one of these. The plan is narrowed to
 * the three fields a console needs rather than the whole `PlanSchema`, so
 * nothing here depends on a price or a provider id.
 *
 * `seatsPending` is separate from `seatsUsed` for the reason 0009 gives for
 * counting both against the cap: an admin who could mint unlimited pending
 * invites would blow past the seat limit the moment a mailout landed. The
 * console shows the sum against the cap and names the two parts, so "4 of 5,
 * one invitation outstanding" is legible rather than arithmetic the reader has
 * to do.
 */
export const TenantLifecycleResponseSchema = z.object({
  status: TenantStatusSchema,
  trialEndsAt: TimestampSchema.nullable(),
  /** When a `past_due` or `cancelled` tenant becomes `suspended`. */
  gracePeriodEndsAt: TimestampSchema.nullable(),
  /** When a `suspended` tenant's data is destroyed. */
  purgeAt: TimestampSchema.nullable(),
  plan: PlanSchema.pick({ key: true, name: true, entitlements: true }),
  usage: z.object({
    seatsUsed: z.int().nonnegative(),
    /** Invitations sent and not yet accepted. Counted against the seat cap. */
    seatsPending: z.int().nonnegative(),
    conversationsThisPeriod: z.int().nonnegative(),
  }),
});

export const TenantUpdateInputSchema = z.object({
  name: TenantNameSchema.optional(),
  branding: BrandingUpdateInputSchema.optional(),
});

export const TenantCancelInputSchema = z.object({
  /** Operator- and admin-supplied free text for the trail. Never rendered back to the tenant. */
  reason: z.string().max(500).optional(),
});

/**
 * Typing the name of the thing you are destroying is the cheapest possible guard
 * against the one irreversible action in the product. `confirmSlug` must equal
 * the tenant's own slug, checked server-side — the client having asked nicely is
 * not the check.
 */
export const TenantDeleteInputSchema = z.object({
  confirmSlug: TenantSlugSchema,
  reason: z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Business hours — TAR-279 / TAR-288
// ---------------------------------------------------------------------------

/**
 * `tenant_settings.business_hours` has had a documented shape since TAR-47 and
 * no interpreter. 0007 is its first consumer, so it publishes the schema and the
 * predicate here rather than letting each caller invent a private reading of a
 * shared column.
 *
 * **What this owns, and what it does not.** 0006 put business-hours accounting
 * out of scope for SLA timers on the grounds that turning it on means a holiday
 * calendar *and* timezone arithmetic. This is the arithmetic half — is this
 * instant inside the hours — and nothing more. A per-tenant holiday and
 * exception calendar is still nobody's, and stays 0006's risk 1.
 */
export const BUSINESS_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export const BusinessDaySchema = z.enum(BUSINESS_DAYS);

/** `HH:MM`, 24-hour, zero-padded. `24:00` is accepted as an end-of-day `to`. */
export const ClockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);

/** `from` is inclusive, `to` is exclusive: `09:00`–`17:00` excludes 17:00:00. */
export const BusinessHoursIntervalSchema = z.object({
  from: ClockTimeSchema,
  to: ClockTimeSchema,
});

/**
 * A day absent from the record is closed. `{}` means the tenant is never open,
 * which is not the same as the column being `null` — that means the tenant never
 * configured hours at all, and 0007's decision 3 handles it by refusing to
 * guess.
 *
 * `partialRecord`, not `record`, and that is the one place this deviates from
 * 0007's transcript. Zod 4 made an enum-keyed `z.record` **exhaustive**: it
 * requires every member of the key enum to be present, so the document's literal
 * `z.record(z.enum(BUSINESS_DAYS), …)` refuses the seeded Northwind tenant,
 * which lists `mon`–`fri` and no weekend. The published *behaviour* — an absent
 * day is closed — is what this keeps; only the combinator changes.
 */
export const BusinessHoursSchema = z.partialRecord(
  BusinessDaySchema,
  z.array(BusinessHoursIntervalSchema).max(4),
);

export type BusinessDay = z.infer<typeof BusinessDaySchema>;
export type BusinessHoursInterval = z.infer<typeof BusinessHoursIntervalSchema>;
export type BusinessHours = z.infer<typeof BusinessHoursSchema>;

/** Minutes in a day, and the value `24:00` parses to. */
const MINUTES_PER_DAY = 24 * 60;

/**
 * Is `at` inside the tenant's opening hours?
 *
 * Four semantics a reader cannot derive from the shape, and that two
 * implementations would otherwise disagree on:
 *
 *   1. **`from` is inclusive, `to` is exclusive.**
 *   2. **An interval whose `to` is at or before its `from` wraps past
 *      midnight**, and the day key names the day it *starts*:
 *      `fri { from: '22:00', to: '02:00' }` covers Saturday 00:00–02:00, which is
 *      why the previous day is consulted as well as the current one.
 *   3. **An absent day key is closed.** `null` hours are "never open" here; 0007
 *      decides separately that a `business_hours` *condition* against an
 *      unconfigured tenant evaluates false either way rather than matching.
 *   4. **The comparison happens in `timezone`**, an IANA name. Stored timestamps
 *      stay `timestamptz`; nothing here changes how a time is stored.
 *
 * Daylight saving needs no special case, and that is a property of working from
 * the formatted wall clock rather than from date arithmetic: `Intl` maps a real
 * instant to the wall clock that actually occurred. On a spring-forward date the
 * skipped hour simply has no instants inside it, and on an autumn-back date the
 * repeated hour has two runs of them — both inside the interval, both correctly
 * "within". `isWithinBusinessHours.test.ts` pins both.
 *
 * An unresolvable `timezone` would make every answer for that tenant silently
 * wrong, so it throws rather than falling back to UTC. `IanaTimezoneSchema`
 * validates the column on write; this is the backstop for a row that predates it.
 */
export function isWithinBusinessHours(
  hours: BusinessHours | null,
  timezone: IanaTimezone,
  at: Date,
): boolean {
  if (hours === null) {
    return false;
  }

  const { today, yesterday, minutes } = wallClockIn(timezone, at);

  return (
    covers(hours[today], minutes) ||
    // Only a wrapping interval can reach into today, and it reaches `to` minutes
    // past midnight — so today's clock is compared as if it were yesterday's,
    // one day on.
    covers(hours[yesterday], minutes + MINUTES_PER_DAY)
  );
}

function covers(intervals: readonly BusinessHoursInterval[] | undefined, minutes: number): boolean {
  return (intervals ?? []).some((interval) => {
    const from = toMinutes(interval.from);
    const to = toMinutes(interval.to);
    // A `to` at or before `from` wraps past midnight, so the interval runs to
    // the same clock time on the following day.
    const end = to <= from ? to + MINUTES_PER_DAY : to;

    return minutes >= from && minutes < end;
  });
}

/**
 * `en-GB` with an explicit `hourCycle`: the locale's own default renders
 * midnight as `24:00` in some ICU versions, which would parse as 1440 and put
 * every midnight outside every interval.
 */
const WALL_CLOCK_PARTS = { weekday: 'short', hour: '2-digit', minute: '2-digit' } as const;

interface WallClock {
  readonly today: BusinessDay;
  /**
   * The day before `today`, taken from the weekday rather than by subtracting 24
   * hours from `at`: the previous *calendar* day in a zone is not always 24
   * hours earlier, and the key is all that is needed to find an interval that
   * started yesterday and has not ended yet.
   */
  readonly yesterday: BusinessDay;
  readonly minutes: number;
}

function wallClockIn(timezone: IanaTimezone, at: Date): WallClock {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hourCycle: 'h23',
    ...WALL_CLOCK_PARTS,
  }).formatToParts(at);

  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const dayIndex = BUSINESS_DAYS.indexOf(read('weekday').slice(0, 3).toLowerCase() as BusinessDay);
  const today = BUSINESS_DAYS[dayIndex];
  const yesterday = BUSINESS_DAYS[(dayIndex + 6) % 7];

  if (today === undefined || yesterday === undefined) {
    // Unreachable with `en-GB`, whose short weekday is always a three-letter
    // English abbreviation. Said out loud rather than defaulting to Monday,
    // which would be a wrong answer disguised as a working one.
    throw new RangeError(`Could not read a weekday in ${timezone}`);
  }

  return { today, yesterday, minutes: Number(read('hour')) * 60 + Number(read('minute')) };
}

function toMinutes(clockTime: string): number {
  const [hours, minutes] = clockTime.split(':');

  return Number(hours) * 60 + Number(minutes);
}

/**
 * How a request tells the API which tenant it is for, once it has crossed the
 * web tier (ADR 0005, TAR-64).
 *
 * `HostTenantGuard` resolves the tenant from the host, and the host alone. It
 * cannot read it from `Host` in any deployed environment: Render routes by
 * `Host` at its edge, so a request only reaches the API service if `Host` names
 * the *API*, and a tenant's custom domain is attached to the web service. The
 * browser path loses it at the `/api/*` rewrite — Next's proxy hardcodes
 * `changeOrigin: true` — and the server path cannot restore it, because `fetch`
 * derives `Host` from the URL and drops a caller-supplied one.
 *
 * So the tenant host travels in `x-edge-host`, and `x-edge-auth` is what makes it
 * trustworthy: the host is only honoured when the request also presents the
 * shared secret the web tier and the API both hold. Without it the guard falls
 * back to `Host` exactly as before — **never** to the forwarded value, because a
 * header any caller can set is a tenant any caller can choose.
 *
 * ## Why `x-edge-host` and not `x-forwarded-host` (TAR-148)
 *
 * `x-forwarded-host` is a standard forwarding header, and every hop on the path
 * is entitled to set, overwrite or append to it. The web tier does not reach the
 * API over a private network — it calls
 * `https://whatsappcrm-api-<env>.onrender.com`, so the request leaves Render and
 * re-enters through TLS-terminating proxies that populate `x-forwarded-*` as a
 * matter of course. An edge that rewrote it would leave every tenant route
 * answering a uniform `tenant_not_found` while both services still reported the
 * feature enabled. A private name nothing on the path has an opinion about
 * cannot be clobbered by accident, so both halves of the pair are private names.
 *
 * Named here so the two applications and their tests cannot drift apart, for the
 * same reason `sessionCookieName` lives in this package — and because this pair
 * is the one place a rename has to happen exactly once. The API reads these two
 * and never reads `x-forwarded-host`, gated or otherwise
 * (`apps/api/src/tenancy/host-tenant.guard.ts`).
 */
export const TENANT_HOST_HEADER = 'x-edge-host';

/** The shared secret proving `x-edge-host` came from our own web tier. */
export const EDGE_AUTH_HEADER = 'x-edge-auth';

export type BrandingAsset = z.infer<typeof BrandingAssetSchema>;
export type TenantBranding = z.infer<typeof TenantBrandingSchema>;
export type BrandingUpdateInput = z.infer<typeof BrandingUpdateInputSchema>;
export type DomainVerification = z.infer<typeof DomainVerificationSchema>;
export type DomainRouting = z.infer<typeof DomainRoutingSchema>;
export type TenantDomain = z.infer<typeof TenantDomainSchema>;
export type TenantDomainCreateInput = z.infer<typeof TenantDomainCreateInputSchema>;
export type TenantDomainParams = z.infer<typeof TenantDomainParamsSchema>;
export type TenantDomainListResponse = z.infer<typeof TenantDomainListResponseSchema>;
export type TenantResponse = z.infer<typeof TenantResponseSchema>;
export type TenantLifecycleResponse = z.infer<typeof TenantLifecycleResponseSchema>;
export type TenantPublicResponse = z.infer<typeof TenantPublicResponseSchema>;
export type TenantUpdateInput = z.infer<typeof TenantUpdateInputSchema>;
export type TenantLifecycleEvent = z.infer<typeof TenantLifecycleEventSchema>;
export type TenantCancelInput = z.infer<typeof TenantCancelInputSchema>;
export type TenantDeleteInput = z.infer<typeof TenantDeleteInputSchema>;
