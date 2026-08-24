import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { MediaStorageModule } from '../media/storage/media-storage.module';
import { AdminTenantLifecycleService } from './lifecycle/admin-tenant-lifecycle.service';
import { LifecycleEventsRepository } from './lifecycle/lifecycle-events.repository';
import { TenantLifecycleController } from './lifecycle/tenant-lifecycle.controller';
import { TenantLifecycleNotifier } from './lifecycle/tenant-lifecycle.notifier';
import { TenantLifecycleReader } from './lifecycle/tenant-lifecycle.reader';
import { TenantLifecycleService } from './lifecycle/tenant-lifecycle.service';
import { TenantLifecycleSweeper } from './lifecycle/tenant-lifecycle.sweeper';
import { TenantPurgeService } from './lifecycle/tenant-purge.service';
import { TenantOnboardingController } from './onboarding/tenant-onboarding.controller';
import { TenantOnboardingReader } from './onboarding/tenant-onboarding.reader';
import { TenantOnboardingService } from './onboarding/tenant-onboarding.service';
import { AdminDomainsController } from './admin/admin-domains.controller';
import { AdminDomainsService } from './admin/admin-domains.service';
import { AdminTenantScopeService } from './admin/admin-tenant-scope.service';
import { AdminTenantsController } from './admin/admin-tenants.controller';
import { PlatformAdminGuard } from './admin/platform-admin.guard';
import { TenantBrandingService } from './branding/tenant-branding.service';
import { DNS_CHALLENGE_RESOLVER, NodeDnsChallengeResolver } from './domains/dns-challenge.resolver';
import { DomainOwnershipChecker } from './domains/domain-ownership.checker';
import { DomainVerificationSweeper } from './domains/domain-verification.sweeper';
import { TenancyQueueRunner } from './domains/tenancy-queue.runner';
import { TenantDomainsController } from './domains/tenant-domains.controller';
import { TenantDomainsService } from './domains/tenant-domains.service';
import { TenantController } from './tenant.controller';
import { TenantDeactivationService } from './tenant-deactivation.service';
import { TenantProfileService } from './tenant-profile.service';
import { TenantProvisioningService } from './tenant-provisioning.service';

/**
 * Tenant identity, branding, domains and lifecycle (TAR-39, module map). TAR-19
 * puts provisioning and deactivation here; TAR-29 adds the white-label surface —
 * the tenant's own record, its branding, and the custom domains it answers on.
 *
 * Three services are exported because other flows drive them rather than
 * reimplementing their transactions: TAR-36's graduation path and any future
 * signup provision through the first, dunning and account closure deactivate
 * through the second, and every other module's platform-admin routes enter a
 * tenant's scope through the third (TAR-20a's WhatsApp connection endpoints are
 * the first). Everything TAR-29 adds stays private: a second caller of the
 * branding service would be a second place a tenant's storage keys are reached.
 *
 * `MediaStorageModule` is the one import, and it is deliberately not
 * `MediaModule`: what branding reuses is the blob **port**, not the
 * `media_objects` table, whose kinds and retention sweep are Meta's vocabulary.
 * Importing the whole media module would drag `WhatsAppModule` and the
 * credential boundary behind it into tenant settings.
 *
 * `PlatformAdminGuard` is deliberately **not** exported. A guard is cheap to
 * construct and carries no state, so another module declaring its own instance
 * costs nothing and keeps the authentication decision visible in that module's
 * own provider list rather than inherited from an import.
 *
 * `SystemPrisma`, `TenantPrisma`, `TenantContextService`, `AuditService` and
 * `QueueService` all come from global modules and are not imported here.
 */
@Module({
  imports: [MediaStorageModule, EntitlementsModule],
  controllers: [
    TenantController,
    TenantLifecycleController,
    TenantOnboardingController,
    TenantDomainsController,
    AdminTenantsController,
    AdminDomainsController,
  ],
  providers: [
    TenantProvisioningService,
    TenantDeactivationService,
    TenantProfileService,
    TenantBrandingService,
    TenantDomainsService,
    DomainOwnershipChecker,
    DomainVerificationSweeper,
    TenancyQueueRunner,
    TenantLifecycleService,
    TenantLifecycleReader,
    TenantLifecycleNotifier,
    TenantLifecycleSweeper,
    TenantPurgeService,
    LifecycleEventsRepository,
    TenantOnboardingReader,
    TenantOnboardingService,
    AdminTenantLifecycleService,
    AdminTenantScopeService,
    AdminDomainsService,
    PlatformAdminGuard,
    ApiExceptionFilter,
    {
      // The timeout is configuration, and a decorator is evaluated before
      // `ConfigService` exists — the same reason `MediaModule` registers multer
      // asynchronously rather than passing options to `FileInterceptor`.
      provide: DNS_CHALLENGE_RESOLVER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new NodeDnsChallengeResolver(config.getOrThrow<number>('DOMAIN_VERIFICATION_TIMEOUT_MS')),
    },
  ],
  exports: [
    TenantProvisioningService,
    TenantDeactivationService,
    AdminTenantScopeService,
    // TAR-37's billing adapter drives `applyBillingEvent` from its webhook
    // consumer, which is the seam that keeps a provider out of lifecycle logic.
    // Exported now, with no consumer, because the alternative when that story
    // lands is a module edit inside a story that should only be adding an
    // adapter.
    TenantLifecycleService,
  ],
})
export class TenancyModule {}
