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

export type ProvisionTenantInput = z.infer<typeof ProvisionTenantInputSchema>;
export type ProvisionedTenantResponse = z.infer<typeof ProvisionedTenantResponseSchema>;
