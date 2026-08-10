import { z } from 'zod';
import { HexColorSchema, IdSchema, TimestampSchema } from './common';

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

export const TenantUpdateInputSchema = z.object({
  name: TenantNameSchema.optional(),
  branding: TenantBrandingSchema.partial().optional(),
});

export type TenantBranding = z.infer<typeof TenantBrandingSchema>;
export type TenantDomain = z.infer<typeof TenantDomainSchema>;
export type TenantResponse = z.infer<typeof TenantResponseSchema>;
export type TenantPublicResponse = z.infer<typeof TenantPublicResponseSchema>;
export type TenantUpdateInput = z.infer<typeof TenantUpdateInputSchema>;
