import { z } from 'zod';
import { IanaTimezoneSchema, IdSchema, LocaleSchema, TimestampSchema } from './common';
import { TenantNameSchema, TenantSlugSchema } from './tenant';

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
 * The vocabulary of the `tenants.status` column, which is what the platform's
 * own view of a tenant reports.
 *
 * **It is not `TENANT_STATUSES`, and that is a known drift.** The two were
 * authored by different stories against different concerns: `TENANT_STATUSES`
 * in `tenant.ts` is the billing-driven lifecycle a customer sees
 * (`trialing`/`past_due`/`deleted`), while the column TAR-47 shipped models
 * provisioning state and has `pending`, which the customer-facing set has no
 * spelling for. Reconciling them is TAR-36's — it owns the lifecycle state
 * machine — and doing it here would mean either an `ALTER TYPE` nobody asked
 * for or a lossy mapper that reports `pending` as something it is not.
 *
 * `contract.test.ts` pins the overlap so the drift cannot widen unnoticed.
 */
export const PROVISIONED_TENANT_STATUSES = [
  /** Row exists, provisioning has not finished. Never returned by a successful provision. */
  'pending',
  'active',
  'suspended',
  'cancelled',
] as const;

export const ProvisionedTenantStatusSchema = z.enum(PROVISIONED_TENANT_STATUSES);

export type ProvisionedTenantStatus = (typeof PROVISIONED_TENANT_STATUSES)[number];

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
  status: ProvisionedTenantStatusSchema,
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
  status: ProvisionedTenantStatusSchema,
  suspendedAt: TimestampSchema.nullable(),
});

export type ProvisionTenantInput = z.infer<typeof ProvisionTenantInputSchema>;
export type ProvisionedTenantResponse = z.infer<typeof ProvisionedTenantResponseSchema>;
export type DeactivateTenantParams = z.infer<typeof DeactivateTenantParamsSchema>;
export type DeactivateTenantInput = z.infer<typeof DeactivateTenantInputSchema>;
export type DeactivatedTenantResponse = z.infer<typeof DeactivatedTenantResponseSchema>;
