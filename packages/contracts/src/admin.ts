import { z } from 'zod';
import { IanaTimezoneSchema, IdSchema, LocaleSchema, TimestampSchema } from './common';
import {
  TenantLifecycleEventSchema,
  TenantNameSchema,
  TenantSlugSchema,
  TenantStatusSchema,
} from './tenant';

/**
 * The **platform-admin** surface: operations performed by us on the platform,
 * not by a customer inside their own tenant.
 *
 * Kept in its own file rather than folded into `tenant.ts` because the two have
 * different callers, different authentication and different blast radius.
 * Everything in `tenant.ts` is reachable by a tenant's own users with the right
 * role; nothing here is, ever. TAR-19 provisions, TAR-36 drives the rest of the
 * lifecycle, TAR-51 deactivates.
 */

/**
 * There is no separate provisioning status vocabulary any more.
 *
 * `PROVISIONED_TENANT_STATUSES` lived here because the `tenants.status` column
 * and `TENANT_STATUSES` were authored by different stories against different
 * concerns, and spelled the pre-provisioning state `pending` and `created`
 * respectively. TAR-403 renamed the column's label and added the three it was
 * missing; TAR-404 adds `created` to the published set. The two are now the same
 * seven values in the same order, so a second name for one of them is a place
 * for drift to reappear rather than a distinction worth keeping (0009,
 * decision 1).
 *
 * The platform-admin surface therefore reports `TenantStatusSchema`, and
 * `contract.test.ts` pins the set so the reconciliation cannot come apart.
 */

/**
 * `POST /api/v1/admin/tenants` — admin-triggered tenant provisioning (TAR-19).
 *
 * `slug` is the identity of the request, which is what makes provisioning
 * idempotent: the same slug provisions once and is a no-op afterwards. It is
 * therefore also the thing a caller cannot change later, so it is required
 * rather than derived from `name` — deriving it would hand a typo in a display
 * name to DNS permanently.
 *
 * `timezone` and `locale` seed `tenant_settings`; both fall back to the
 * defaults in the schema (`UTC`, `en`) when omitted.
 */
export const ProvisionTenantInputSchema = z.object({
  slug: TenantSlugSchema,
  name: TenantNameSchema,
  timezone: IanaTimezoneSchema.optional(),
  locale: LocaleSchema.optional(),
});

/**
 * What provisioning returns. Deliberately not `TenantResponseSchema`: this is
 * the platform's view of a freshly provisioned tenant, and it reports the
 * things the operator needs to hand over — where the tenant is reachable and
 * what its settings were seeded with — rather than the branding and domain list
 * a tenant-facing `GET /tenant` returns.
 *
 * A caller distinguishes "provisioned now" from "already existed" by the status
 * code: `201` for the first, `200` for a repeat. The body is identical either
 * way, because an idempotent operation that reports a different resource on
 * replay is not idempotent.
 */
export const ProvisionedTenantResponseSchema = z.object({
  id: IdSchema,
  slug: TenantSlugSchema,
  name: TenantNameSchema,
  status: TenantStatusSchema,
  /** Where the tenant is reachable: the platform subdomain issued for its slug. */
  primaryHostname: z.string().min(1).max(253),
  settings: z.object({
    timezone: IanaTimezoneSchema,
    locale: LocaleSchema,
  }),
  createdAt: TimestampSchema,
});

/**
 * `POST /api/v1/admin/tenants/{slug}/deactivate` — take a tenant's access away
 * while keeping its data (TAR-51).
 *
 * A sub-resource POST rather than a `PATCH` that sets `status`: deactivation is
 * an operation with consequences beyond the column — the tenant's agents stop
 * reaching their data from the moment it commits — and the conventions in
 * TAR-39 put a non-CRUD verb on a sub-resource rather than in a body field.
 * Modelling it as a status write would also invite the inverse write, and
 * reactivation is TAR-36's lifecycle to own.
 *
 * The slug identifies the tenant for the same reason it identifies a
 * provisioning request: it is what an operator has in front of them, and unlike
 * an id it cannot be a tenant they did not mean.
 */
export const DeactivateTenantParamsSchema = z.object({
  slug: TenantSlugSchema,
});

/**
 * `reason` is free text for the audit trail — why this tenant was deactivated,
 * in the words of whoever did it. Optional, because an operator acting on an
 * incident should not be blocked by a required field, and never rendered to the
 * tenant.
 */
export const DeactivateTenantInputSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

/**
 * What deactivation reports. Always `200`, whether this call deactivated the
 * tenant or found it already deactivated: the operation is idempotent, and the
 * state it describes — `status`, and when the tenant was suspended — is the
 * same either way.
 *
 * `suspendedAt` is nullable because a tenant can reach a non-active status
 * without going through this endpoint (a `pending` row abandoned by a failed
 * provision, a `cancelled` one closed by TAR-36). It says when deactivation
 * happened, not that it did.
 */
export const DeactivatedTenantResponseSchema = z.object({
  id: IdSchema,
  slug: TenantSlugSchema,
  name: TenantNameSchema,
  status: TenantStatusSchema,
  suspendedAt: TimestampSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Operator lifecycle — TAR-36 / TAR-404 (ADR 0009, endpoint surface)
// ---------------------------------------------------------------------------

/**
 * The slug on the four operator lifecycle routes —
 * `POST /admin/tenants/{slug}/reactivate`, `/cancel`, `/delete`, and
 * `GET /admin/tenants/{slug}/lifecycle`.
 *
 * The same shape `DeactivateTenantParamsSchema` publishes for the same reason;
 * kept separate rather than aliased so renaming a route's parameter later is one
 * edit rather than a shared type two surfaces had grown to depend on.
 */
export const AdminTenantParamsSchema = z.object({
  slug: TenantSlugSchema,
});

/** Free text for the trail. Never rendered to the tenant. */
export const AdminTenantCancelInputSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

/**
 * `POST /api/v1/admin/tenants/{slug}/delete`.
 *
 * Like its tenant-facing twin it **schedules**: the tenant is cancelled with a
 * grace period, reaches `suspended`, and only then is purged when `purge_at`
 * elapses. TAR-36's criterion is "when the retention window elapses, then tenant
 * data is permanently deleted", and an endpoint that destroyed data
 * synchronously would have no window.
 *
 * `force` is the one way to skip the windows, and it exists for a
 * right-to-erasure request that cannot wait 44 days. It goes straight to
 * `suspended` with `purge_at` set to now, so the very next sweep purges — and it
 * is audited with `trigger: operator_action` like everything else here.
 */
export const AdminTenantDeleteInputSchema = z.object({
  force: z.boolean().default(false),
  reason: z.string().min(1).max(500).optional(),
});

/**
 * What the three operator lifecycle actions report.
 *
 * Deliberately not `TenantLifecycleResponse`: that one carries the plan and the
 * seat usage a console renders, which an operator acting on an incident does not
 * need and which would make the response depend on `tenant_entitlements` being
 * populated. This is the tenant's identity plus every lifecycle instant, which
 * is what an operator has to be able to read back — "when does this purge" is
 * the question the route is answered with.
 */
export const AdminTenantLifecycleResponseSchema = z.object({
  id: IdSchema,
  slug: TenantSlugSchema,
  name: TenantNameSchema,
  status: TenantStatusSchema,
  trialEndsAt: TimestampSchema.nullable(),
  /** When a `past_due` or `cancelled` tenant becomes `suspended`. */
  gracePeriodEndsAt: TimestampSchema.nullable(),
  suspendedAt: TimestampSchema.nullable(),
  cancelledAt: TimestampSchema.nullable(),
  /** When a `suspended` tenant's data is destroyed. */
  purgeAt: TimestampSchema.nullable(),
  deletedAt: TimestampSchema.nullable(),
});

/**
 * One lifecycle row as the **operator** sees it: `TenantLifecycleEvent` plus
 * `reason`.
 *
 * `reason` is where an operator writes "fraud, card chargeback". ADR 0009's
 * security section says that is not a sentence to show a customer, so the
 * tenant-facing schema omits the field and this one carries it. Two schemas
 * rather than one optional field, because an optional field is one a handler can
 * populate on the wrong route.
 */
export const AdminTenantLifecycleEventSchema = TenantLifecycleEventSchema.extend({
  reason: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Custom-domain activation — TAR-29 / TAR-419
// ---------------------------------------------------------------------------

/**
 * The operator's queue: domains a tenant has proved it owns, waiting to be
 * attached at the edge (`docs/runbooks/custom-domains.md`).
 *
 * Attaching a domain is deliberately an operator step rather than something the
 * verification service does — TAR-416 declined to invent a contract against
 * Render's API nobody here has read. The cost of that decision is that a
 * verified domain sits waiting until somebody looks, so the queue is a first-
 * class endpoint rather than a database query an operator has to be told.
 *
 * It names the tenant, because an operator has to attach the hostname to the
 * right environment's web service and needs to know whose it is. Nothing else
 * about the tenant is exposed.
 */
export const AdminPendingDomainSchema = z.object({
  tenantSlug: TenantSlugSchema,
  tenantName: TenantNameSchema,
  hostname: z.string().min(4).max(253),
  verifiedAt: TimestampSchema,
  activatedAt: TimestampSchema.nullable(),
});

export const AdminPendingDomainListResponseSchema = z.object({
  items: z.array(AdminPendingDomainSchema),
});

/**
 * `?status=` on the queue. `verified` is a verified domain that has not been
 * attached — the thing an operator acts on — and `live` is one that has, so the
 * same endpoint answers "what is waiting" and "what did I attach".
 */
export const ADMIN_DOMAIN_QUERY_STATUSES = ['verified', 'live'] as const;

export const AdminDomainQuerySchema = z.object({
  status: z.enum(ADMIN_DOMAIN_QUERY_STATUSES).default('verified'),
});

/**
 * `POST /api/v1/admin/tenants/{slug}/domains/{hostname}/activate` and its
 * inverse.
 *
 * The hostname rather than the domain's id, because an operator has the
 * hostname in front of them — in the Render dashboard, in the support ticket —
 * and an id they have to look up first is an id they can get wrong.
 */
export const AdminDomainParamsSchema = z.object({
  slug: TenantSlugSchema,
  hostname: z.string().min(4).max(253),
});

export type ProvisionTenantInput = z.infer<typeof ProvisionTenantInputSchema>;
export type AdminPendingDomain = z.infer<typeof AdminPendingDomainSchema>;
export type AdminPendingDomainListResponse = z.infer<typeof AdminPendingDomainListResponseSchema>;
export type AdminDomainQuery = z.infer<typeof AdminDomainQuerySchema>;
export type AdminDomainParams = z.infer<typeof AdminDomainParamsSchema>;
export type ProvisionedTenantResponse = z.infer<typeof ProvisionedTenantResponseSchema>;
export type DeactivateTenantParams = z.infer<typeof DeactivateTenantParamsSchema>;
export type DeactivateTenantInput = z.infer<typeof DeactivateTenantInputSchema>;
export type DeactivatedTenantResponse = z.infer<typeof DeactivatedTenantResponseSchema>;
export type AdminTenantParams = z.infer<typeof AdminTenantParamsSchema>;
export type AdminTenantCancelInput = z.infer<typeof AdminTenantCancelInputSchema>;
export type AdminTenantDeleteInput = z.infer<typeof AdminTenantDeleteInputSchema>;
export type AdminTenantLifecycleResponse = z.infer<typeof AdminTenantLifecycleResponseSchema>;
export type AdminTenantLifecycleEvent = z.infer<typeof AdminTenantLifecycleEventSchema>;
