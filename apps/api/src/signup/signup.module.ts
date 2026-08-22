import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TenancyModule } from '../tenancy/tenancy.module';
import { SignupController } from './signup.controller';
import { SignupThrottleService } from './signup-throttle.service';
import { TenantSignupService } from './tenant-signup.service';

/**
 * Public self-signup (TAR-405).
 *
 * A module of its own rather than routes on `IdentityModule`, because the
 * posture is different in the one way that matters: everything in identity runs
 * with a tenant resolved from the host, and nothing here does. Keeping them
 * apart means a route cannot pick up `@PublicPlatformRoute()` by accident from a
 * controller it was filed next to — the same reasoning that put `AuthController`
 * on its own class away from `SessionController`.
 *
 * `TenancyModule` is imported for `TenantProvisioningService`: signup drives
 * TAR-19's provisioning rather than reimplementing it, which is what keeps a
 * self-serve tenant indistinguishable from an operator-provisioned one save for
 * the status and caps it starts on. `TenantLifecycleService` comes from the same
 * import, for one call: provisioning runs inside signup's transaction, so signup
 * is the only place that knows when the genesis row has committed and the
 * `tenant_welcome` job may be queued.
 *
 * Everything else it needs is already global — `SystemPrisma` from
 * `PrismaModule`, and `PasswordService`, `SessionService` and `MAILER` from
 * `IdentityModule`. `AuthRedisClient` comes from there too, so the throttle
 * shares the one Redis connection rather than opening a second.
 */
@Module({
  imports: [TenancyModule],
  controllers: [SignupController],
  providers: [TenantSignupService, SignupThrottleService, ApiExceptionFilter],
})
export class SignupModule {}
