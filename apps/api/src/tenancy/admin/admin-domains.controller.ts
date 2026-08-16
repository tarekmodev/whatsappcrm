import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  AdminDomainParamsSchema,
  AdminDomainQuerySchema,
  type AdminDomainParams,
  type AdminDomainQuery,
  type AdminPendingDomainListResponse,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../../common/errors/api-exception.filter';
import { PlatformRoute } from '../../common/request-pipeline/route-access';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AdminTenantScopeService } from './admin-tenant-scope.service';
import { AdminDomainsService } from './admin-domains.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { translateTenancyFailure } from '../tenancy.http';

/**
 * The platform-operator surface for custom domains (TAR-419,
 * `docs/runbooks/custom-domains.md`).
 *
 * Two responsibilities, and they are the two halves of the manual step TAR-416
 * chose to keep manual: **find what is waiting**, and **record that it has been
 * attached**. Attaching the hostname itself is a Render Dashboard action; this
 * is what stops it being forgotten and what gives the audit trail a row naming
 * the operator credential that did it.
 *
 * `@PlatformRoute()` takes these out of the tenant pipeline — the operator is
 * not a user in any tenant, and the queue spans all of them — and
 * `PlatformAdminGuard` is the authentication that replaces it. The guard is on
 * the class rather than per route, so a route added later is protected by
 * default rather than by remembering.
 *
 * The activate/deactivate pair names one tenant by slug and enters that tenant's
 * scope explicitly before touching a row, so RLS still bounds the write. That is
 * not ceremony: it is what makes "attached the wrong tenant's domain" impossible
 * rather than merely unlikely, and the environment mix-up the runbook warns
 * about is the one failure this cannot catch.
 */
@Controller({ path: 'admin', version: '1' })
@PlatformRoute()
@UseGuards(PlatformAdminGuard)
@UseFilters(ApiExceptionFilter)
export class AdminDomainsController {
  constructor(
    private readonly domains: AdminDomainsService,
    private readonly tenantScope: AdminTenantScopeService,
  ) {}

  /**
   * `GET /api/v1/admin/domains?status=verified` — the activation queue.
   *
   * Watch it: TAR-416 names "verified for more than 24 hours with no
   * activation" as the failure mode this feature actually has. A daily digest
   * rather than a page — nothing here is urgent enough to wake anyone, and a
   * queue nobody watches is the whole risk of keeping the step manual.
   */
  @Get('domains')
  async pending(
    @Query(new ZodValidationPipe(AdminDomainQuerySchema)) query: AdminDomainQuery,
  ): Promise<AdminPendingDomainListResponse> {
    const items = await this.domains
      .pending(query.status)
      .catch((error: unknown) => translateTenancyFailure(error));

    return { items };
  }

  /** Records that the hostname is attached at the edge with a certificate. */
  @Post('tenants/:slug/domains/:hostname/activate')
  @HttpCode(HttpStatus.NO_CONTENT)
  async activate(
    @Param(new ZodValidationPipe(AdminDomainParamsSchema)) params: AdminDomainParams,
  ): Promise<void> {
    await this.withinTenant(params, async () => await this.domains.activate(params.hostname));
  }

  /** The inverse, once the hostname has been removed from the web service. */
  @Post('tenants/:slug/domains/:hostname/deactivate')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivate(
    @Param(new ZodValidationPipe(AdminDomainParamsSchema)) params: AdminDomainParams,
  ): Promise<void> {
    await this.withinTenant(params, async () => await this.domains.deactivate(params.hostname));
  }

  /**
   * Binds the tenant named in the path to this request's scope, then runs the
   * write through `TenantPrisma`.
   *
   * The slug is the operator's own input, so resolving it is also the check that
   * they named a tenant that exists — a mistyped slug is a `404` rather than a
   * silent no-op against nothing.
   */
  private async withinTenant(params: AdminDomainParams, work: () => Promise<void>): Promise<void> {
    await this.tenantScope
      .enter(params.slug)
      .catch((error: unknown) => translateTenancyFailure(error));

    await work().catch((error: unknown) => translateTenancyFailure(error));
  }
}
