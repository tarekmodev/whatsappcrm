import { Global, Module } from '@nestjs/common';
import { QueueService } from './queue.service';

/**
 * BullMQ registration and tenant-context propagation into workers (TAR-39,
 * module map). Owned by TAR-41; this is the minimum the webhook ingestion
 * pipeline needs to run, built to be extended rather than replaced.
 *
 * Global for the same reason `PrismaModule` is: a feature module that had to
 * remember to import it is a feature module that will one day construct its own
 * BullMQ connection, and connections to Redis are a budgeted resource. There is
 * exactly one `QueueService` per process.
 *
 * `TenantContextService` is not imported here — it comes from the global
 * `TenantContextModule`.
 */
@Global()
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
