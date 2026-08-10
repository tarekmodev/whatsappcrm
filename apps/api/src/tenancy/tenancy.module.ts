import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { AdminTenantsController } from './admin/admin-tenants.controller';
import { PlatformAdminGuard } from './admin/platform-admin.guard';
import { TenantProvisioningService } from './tenant-provisioning.service';

/**
 * Tenant identity, domains and lifecycle (TAR-39, module map). TAR-19 puts
 * provisioning here; TAR-36 adds the lifecycle state machine and TAR-51 the
 * deactivation flow alongside it.
 *
 * `TenantProvisioningService` is exported because TAR-36's graduation flow and
 * any future signup path provision through it rather than reimplementing the
 * transaction. The guard and the filter are private: they are wiring for this
 * module's own controller.
 *
 * `SystemPrisma` and `TenantContextService` are not imported here — both come
 * from global modules (`PrismaModule`, `TenantContextModule`).
 */
@Module({
  controllers: [AdminTenantsController],
  providers: [TenantProvisioningService, PlatformAdminGuard, ApiExceptionFilter],
  exports: [TenantProvisioningService],
})
export class TenancyModule {}
