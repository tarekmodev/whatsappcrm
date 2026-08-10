import { Global, Module } from '@nestjs/common';
import { DatabaseProbeService } from './database-probe.service';

/**
 * Global so the health module can reach the probe without importing plumbing.
 * TAR-49's Prisma client belongs alongside it, not instead of the module.
 */
@Global()
@Module({
  providers: [DatabaseProbeService],
  exports: [DatabaseProbeService],
})
export class DatabaseModule {}
