import { Global, Module } from '@nestjs/common';
import { TenantContextMiddleware } from './tenant-context.middleware';
import { TenantContextService } from './tenant-context.service';

/**
 * Global because practically every module — data access, logging, queue
 * producers, the realtime gateway — needs the current tenant, and threading it
 * through constructors would be noise.
 */
@Global()
@Module({
  providers: [TenantContextService, TenantContextMiddleware],
  exports: [TenantContextService, TenantContextMiddleware],
})
export class TenantContextModule {}
