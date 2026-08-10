import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { AdminTenantScopeService } from './admin/admin-tenant-scope.service';
import { AdminTenantsController } from './admin/admin-tenants.controller';
import { PlatformAdminGuard } from './admin/platform-admin.guard';
import { TenantDeactivationService } from './tenant-deactivation.service';
import { TenantProvisioningService } from './tenant-provisioning.service';

/**
 * Tenant identity, domains and lifecycle (TAR-39, module map). TAR-19 puts
 * provisioning and deactivation here; TAR-36 adds the rest of the lifecycle
 * state machine — reactivation, cancellation — alongside them.
 *
 * Three services are exported because other flows drive them rather than
 * reimplementing their transactions: TAR-36's graduation path and any future
 * signup provision through the first, dunning and account closure deactivate
 * through the second, and every other module's platform-admin routes enter a
 * tenant's scope through the third (TAR-20a's WhatsApp connection endpoints are
 * the first). The filter is private: it is wiring for this module's own
 * controller.
 *
 * `PlatformAdminGuard` is deliberately **not** exported. A guard is cheap to
 * construct and carries no state, so another module declaring its own instance
 * costs nothing and keeps the authentication decision visible in that module's
 * own provider list rather than inherited from an import.
 *
 * `SystemPrisma` and `TenantContextService` are not imported here — both come
 * from global modules (`PrismaModule`, `TenantContextModule`).
 */
@Module({
  controllers: [AdminTenantsController],
  providers: [
    TenantProvisioningService,
    TenantDeactivationService,
    AdminTenantScopeService,
    PlatformAdminGuard,
    ApiExceptionFilter,
  ],
  exports: [TenantProvisioningService, TenantDeactivationService, AdminTenantScopeService],
})
export class TenancyModule {}
