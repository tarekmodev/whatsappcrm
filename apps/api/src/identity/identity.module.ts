import { Global, Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionCacheService } from './session-cache.service';
import { SessionController } from './session.controller';
import { SessionPrincipalSource } from './session-principal.source';
import { SessionReplayProbe } from './session-replay.probe';
import { SessionService } from './session.service';

/**
 * Authentication and the session lifecycle (TAR-39's L2 access layer,
 * `IdentityModule`).
 *
 * Deliberately **not** `RbacModule`: this module answers *who is calling*, and
 * that one answers *what they may do*. Nothing here imports the permission
 * vocabulary beyond `permissionsForRole`, which is a pure function in the
 * contract — so the principal can carry materialised permissions without either
 * module depending on the other.
 *
 * ## Why it is global
 *
 * Two providers here are consumed from outside by design, and neither consumer
 * should have to remember an import:
 *
 *   * `SessionPrincipalSource` is what `RbacModule` binds to `PRINCIPAL_SOURCE`
 *     — the seam TAR-22 built its guards around.
 *   * `SessionService` is what `SessionRevocationService` calls, which is how a
 *     people change revokes access in the same transaction that makes it.
 *
 * Neither module lists the other in `imports`, so there is no cycle in the
 * module graph: both are global, and both resolve their tokens from the global
 * registry. Adding an `imports` edge in either direction is what would create
 * one.
 *
 * `ApiExceptionFilter` is declared locally for the same reason `PeopleModule`
 * declares it: it is stateless wiring for this module's own controllers. The
 * `HostTenantGuard` instance that sat beside it went away with TAR-58 —
 * `RequestPipelineModule` now installs it on every route, so `AuthController`
 * states `@Public()` instead of a guard list.
 */
@Global()
@Module({
  controllers: [AuthController, SessionController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    SessionCacheService,
    SessionPrincipalSource,
    SessionReplayProbe,
    ApiExceptionFilter,
  ],
  exports: [PasswordService, SessionService, SessionPrincipalSource],
})
export class IdentityModule {}
