import { Global, Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { PlatformAdminGuard } from '../tenancy/admin/platform-admin.guard';
import { AdminPlatformSettingsController } from './admin/admin-platform-settings.controller';
import { PlatformSettingsRepository } from './platform-settings.repository';
import { PlatformSettingsService } from './platform-settings.service';

/**
 * Runtime-managed platform configuration (TAR-816).
 *
 * ## Why it is global
 *
 * Its consumers are the lowest-level clients in the codebase —
 * `WebhookIngestService` on the public ingest route and `MetaCloudApiClient` in
 * the WhatsApp module — and both read a value the way they used to read
 * `ConfigService`: as ambient configuration, not as a collaborator. Making every
 * such module import this one would be the same "a feature module had to
 * remember" failure `PrismaModule` and `TenantContextModule` are global to
 * avoid, and forgetting would present as a key that silently resolves to null.
 *
 * It is registered early in `AppModule`, before any module that reads a setting,
 * because `PlatformSettingsService.onModuleInit` loads the snapshot and Nest
 * runs those in dependency-then-declaration order. The load happens before the
 * app listens either way, so the ordering is about readability rather than
 * correctness.
 *
 * ## What it does not export
 *
 * `PlatformSettingsRepository` stays private. It is the only class holding
 * `SYSTEM_PRISMA` in this module, and confining it is what keeps that exception
 * auditable — see the repository's own comment for the justification the
 * `prisma.tokens.ts` note asks for.
 *
 * `PlatformAdminGuard` is declared here rather than imported, on the precedent
 * `WhatsAppModule` sets: it is stateless, so a second instance costs nothing,
 * and declaring it keeps the authentication decision visible in this module's
 * own provider list.
 */
@Global()
@Module({
  controllers: [AdminPlatformSettingsController],
  providers: [
    PlatformSettingsRepository,
    PlatformSettingsService,
    PlatformAdminGuard,
    ApiExceptionFilter,
  ],
  exports: [PlatformSettingsService],
})
export class PlatformSettingsModule {}
