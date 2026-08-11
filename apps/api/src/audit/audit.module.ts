import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * The audit trail (TAR-39, security). Global because every story that mutates
 * something security-relevant writes to it, and none of them should be able to
 * ship without it for want of an import.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
