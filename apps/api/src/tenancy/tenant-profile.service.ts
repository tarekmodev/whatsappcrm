import { Inject, Injectable } from '@nestjs/common';
import type { TenantPublicResponse, TenantStatus, TenantUpdateInput } from '@whatsappcrm/contracts';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { TenantBrandingService } from './branding/tenant-branding.service';
import { TenantNotFoundError } from './tenant-deactivation.errors';

/** The tenant's own columns, as `TenantResponse` carries them. */
export interface TenantProfile {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: TenantStatus;
  readonly trialEndsAt: string | null;
  readonly createdAt: string;
}

/**
 * Exactly what a tenant response needs off `tenants`. Notably **not** the
 * lifecycle columns — `grace_period_ends_at`, `purge_at`, `deleted_at` — which
 * belong to `GET /tenant/lifecycle` and are not a tenant's own business to read
 * off its profile.
 */
const TENANT_PROJECTION = {
  id: true,
  name: true,
  slug: true,
  status: true,
  trialEndsAt: true,
  createdAt: true,
} as const;

/**
 * The tenant's own record, as itself (TAR-29, `GET`/`PATCH /api/v1/tenant`).
 *
 * Separate from `TenantBrandingService` because they write different tables and
 * are reached by different permissions — renaming a workspace and choosing a
 * logo are the same request but not the same concern, and folding them together
 * would put a `tenant_branding` upsert inside a service whose name says
 * `tenants`.
 *
 * ## The status vocabulary needs no mapper
 *
 * `tenants.status` and `TENANT_STATUSES` are the same seven values in the same
 * order since TAR-404 published `created`, so the column goes onto the wire
 * unmapped. An earlier revision of this file translated `created` to `trialing`
 * because the published enum could not express it; keeping that now would report
 * a half-provisioned tenant as something it is not, which is the lossy mapping
 * 0009 decision 1 removed the second vocabulary to avoid.
 *
 * In practice the value is unobservable here anyway — provisioning leaves
 * `created` inside the transaction that writes the row, and `HostTenantGuard`
 * answers `tenant_not_found` for a tenant still in it — but "unreachable" is a
 * reason to not translate it, not a reason to translate it wrongly.
 */
@Injectable()
export class TenantProfileService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly branding: TenantBrandingService,
  ) {}

  /**
   * The tenant in scope.
   *
   * `findFirst` with no `where`: RLS narrows `tenants` to the one row this
   * request is for, so naming an id would be re-deriving what the guard already
   * established — and would be the first place a client-supplied tenant id could
   * enter.
   */
  async read(): Promise<TenantProfile> {
    const row = await this.prisma.tenant.findFirst({ select: TENANT_PROJECTION });

    if (row === null) {
      // Unreachable behind `HostTenantGuard`, which resolved this tenant from a
      // verified domain moments ago. Said out loud rather than asserted away:
      // the alternative is a `!` on a row that a hard delete really can remove
      // between the two queries.
      throw new TenantNotFoundError('the tenant in scope');
    }

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * What an anonymous caller may see: the display name and the appearance.
   *
   * Deliberately narrower than `read()` — no slug, no status, no trial date.
   * This response is served on every white-label host to anybody who asks, so
   * every field on it is published to the internet.
   */
  async readPublic(): Promise<TenantPublicResponse> {
    const [profile, branding] = await Promise.all([this.read(), this.branding.read()]);

    return { id: profile.id, name: profile.name, branding };
  }

  /**
   * Renames the workspace. The slug is **not** writable and is not in the input
   * contract: it is baked into the platform subdomain, so changing it would
   * break every bookmark and every session cookie scoped to that host.
   *
   * A patch carrying only `branding` writes nothing here, which is why the
   * update is guarded rather than issued unconditionally — an empty `UPDATE`
   * would still bump `updated_at` and write a row version for a request that
   * changed nothing.
   */
  async update(input: TenantUpdateInput): Promise<void> {
    if (input.name === undefined) {
      return;
    }

    await this.prisma.tenant.updateMany({ data: { name: input.name } });
  }
}
