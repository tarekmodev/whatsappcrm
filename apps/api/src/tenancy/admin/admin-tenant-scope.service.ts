import { Inject, Injectable } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import { SYSTEM_PRISMA, type SystemPrisma } from '../../prisma/prisma.tokens';
import { TenantNotFoundError } from '../tenant-deactivation.errors';

/**
 * Puts a platform-admin request into the tenant context of the tenant it names.
 *
 * ## The problem it solves
 *
 * An admin route identifies its tenant by slug in the path, not by a session, so
 * nothing has called `setTenant()` by the time the handler runs and
 * `TenantPrisma` refuses every query. The two existing admin flows sidestep this
 * because they write `tenants` itself, which is `SystemPrisma`'s table anyway.
 * An admin route that writes **tenant** data — connecting a WhatsApp business
 * account, for one — has no such excuse.
 *
 * The wrong fix is to hand that route `SystemPrisma` and a hand-written
 * `tenantId` filter. That is precisely the "every future query remembers to
 * filter" model TAR-39 rejects, and it would apply it to the table holding the
 * encrypted access token. The right fix is to resolve the tenant once, at the
 * edge, and let RLS enforce the rest — which is what the whole request pipeline
 * does for a session-authenticated request. This is the same step with a
 * different source of truth for who the tenant is.
 *
 * ## Why this is not a hole
 *
 *   * It is reachable only from controllers behind `PlatformAdminGuard`. The
 *     caller is the platform operator, who is authorised for every tenant by
 *     construction.
 *   * It names **one** tenant, taken from the path, and sets it on the
 *     `AsyncLocalStorage` scope the tenant-context middleware opened for this
 *     request alone. There is no way to widen it to two.
 *   * Everything downstream still goes through `TenantPrisma`, so RLS filters
 *     reads, `WITH CHECK` validates writes, and `assert_tenant_active` refuses a
 *     deactivated tenant — an operator cannot connect a channel to a tenant that
 *     has been shut off.
 */
@Injectable()
export class AdminTenantScopeService {
  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Resolves `slug` and binds it to this request's scope. Returns the tenant id. */
  async enter(slug: string): Promise<string> {
    const tenant = await this.systemPrisma.tenant.findUnique({
      where: { slug },
      select: { id: true },
    });

    if (tenant === null) {
      throw new TenantNotFoundError(slug);
    }

    this.tenantContext.setTenant(tenant.id);

    return tenant.id;
  }
}
