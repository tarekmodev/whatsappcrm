import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { CannedResponsesController } from './canned-responses.controller';
import { CannedResponsesService } from './canned-responses.service';

/**
 * The tenant's shared canned-response library (TAR-31), an **L4 feature module**
 * exactly where 0002's module map puts it.
 *
 * It imports nothing from `RealtimeModule` (L1) and `RealtimeModule` imports
 * nothing from it: what the two share is a type on the in-process bus,
 * `CannedResponseChangedEvent` in `events/domain-events.ts`, which is the rule
 * that file states. TAR-485 adds the subscriber; nothing here knows it exists.
 *
 * `CannedResponsesService` is not exported. Nothing else in the API reads or
 * writes this table — the console is the only consumer, over HTTP — and an
 * export nobody imports is a coupling point waiting to be used by accident.
 *
 * Everything it needs comes from global modules: `TenantPrisma` from
 * `PrismaModule`, `TenantContextService` from `TenantContextModule`,
 * `AuditService` from `AuditModule`, `EventEmitter2` from
 * `EventEmitterModule.forRoot()`. No guards are declared — since TAR-58 the
 * three that protect this controller are installed application-wide by
 * `RequestPipelineModule`.
 */
@Module({
  controllers: [CannedResponsesController],
  providers: [CannedResponsesService, ApiExceptionFilter],
})
export class CannedResponsesModule {}
