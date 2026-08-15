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
 * Legal transitions. Anything absent here is a bug, and the transition function
 * in `apps/api` throws rather than silently allowing it — a tenant that goes
 * `deleted → active` is a data-retention incident, not a state change.
 */
export const TENANT_STATUS_TRANSITIONS: Record<TenantStatus, readonly TenantStatus[]> = {
  trialing: ['active', 'cancelled', 'suspended'],
  active: ['past_due', 'cancelled', 'suspended'],
  past_due: ['active', 'suspended', 'cancelled'],
  suspended: ['active', 'cancelled'],
  cancelled: ['active', 'deleted'],
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
 * accepting and persisting them; we just do not let the tenant answer.
 */
export const TENANT_STATUS_EFFECTS: Record<
  TenantStatus,
  { apiAccess: boolean; inboundAccepted: boolean; outboundAllowed: boolean }
> = {
  trialing: { apiAccess: true, inboundAccepted: true, outboundAllowed: true },
  active: { apiAccess: true, inboundAccepted: true, outboundAllowed: true },
  // Fully operational — dunning is a billing banner, not an outage.
  past_due: { apiAccess: true, inboundAccepted: true, outboundAllowed: true },
  suspended: { apiAccess: true, inboundAccepted: true, outboundAllowed: false },
  cancelled: { apiAccess: true, inboundAccepted: false, outboundAllowed: false },
  deleted: { apiAccess: false, inboundAccepted: false, outboundAllowed: false },
};

/** Per-tenant white-label appearance. TAR-29 owns the editor; the shape is fixed here. */
export const TenantBrandingSchema = z.object({
  logoUrl: z.url().nullable(),
  faviconUrl: z.url().nullable(),
  primaryColor: HexColorSchema,
  accentColor: HexColorSchema,
  productName: z.string().min(1).max(60),
  supportEmail: z.email().nullable(),
});

/**
 * A tenant is reachable on one or more hostnames — a platform subdomain always,
 * plus any verified custom domain. Hostname → tenant is the first half of tenant
 * resolution on every request.
 */
export const TenantDomainSchema = z.object({
  id: IdSchema,
  hostname: z.string().min(1).max(253).toLowerCase(),
  kind: z.enum(['platform_subdomain', 'custom']),
  verifiedAt: TimestampSchema.nullable(),
  isPrimary: z.boolean(),
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
  branding: TenantBrandingSchema.partial().optional(),
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

export type TenantBranding = z.infer<typeof TenantBrandingSchema>;
export type TenantDomain = z.infer<typeof TenantDomainSchema>;
export type TenantResponse = z.infer<typeof TenantResponseSchema>;
export type TenantLifecycleResponse = z.infer<typeof TenantLifecycleResponseSchema>;
export type TenantPublicResponse = z.infer<typeof TenantPublicResponseSchema>;
export type TenantUpdateInput = z.infer<typeof TenantUpdateInputSchema>;
