import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { AdminTenantsController } from './admin/admin-tenants.controller';
import { PlatformAdminGuard } from './admin/platform-admin.guard';
import { TenantDeactivationService } from './tenant-deactivation.service';
import { TenantProvisioningService } from './tenant-provisioning.service';

/**
 * Tenant identity, domains and lifecycle (TAR-39, module map). TAR-19 puts
 * provisioning and deactivation here; TAR-36 adds the rest of the lifecycle
 * state machine — reactivation, cancellation — alongside them.
 *
 * Both services are exported because other flows drive them rather than
 * reimplementing their transactions: TAR-36's graduation path and any future
 * signup provision through the first, and dunning and account closure
 * deactivate through the second. The guard and the filter are private: they are
 * wiring for this module's own controller.
 *
 * `SystemPrisma` and `TenantContextService` are not imported here — both come
 * from global modules (`PrismaModule`, `TenantContextModule`).
 */
@Module({
  controllers: [AdminTenantsController],
  providers: [
    TenantProvisioningService,
    TenantDeactivationService,
    PlatformAdminGuard,
    ApiExceptionFilter,
  ],
  exports: [TenantProvisioningService, TenantDeactivationService],
})
export class TenancyModule {}
