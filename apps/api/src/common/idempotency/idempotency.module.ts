import { Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';

/**
 * `Idempotency-Key` handling, as a module rather than a provider in the one
 * feature that uses it today.
 *
 * 0002 requires the header on every `POST` that causes an external side effect —
 * "sends and billing operations" — so TAR-37's checkout and portal calls are the
 * second consumer, and TAR-27's workflow actions the third. A copy per module is
 * how the replay window ends up 24 hours in one place and 10 minutes in another.
 *
 * Everything it needs comes from global modules: `TenantPrisma` from
 * `PrismaModule`, `TenantContextService` from `TenantContextModule`.
 */
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
