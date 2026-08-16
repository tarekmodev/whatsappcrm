import { Global, Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { AuthController } from './auth.controller';
import { AuthRedisClient } from './auth-redis.client';
import { AuthService } from './auth.service';
import { InviteService } from './invite.service';
import { InvitesController } from './invites.controller';
import { ConsoleMailer, UndeliverableMailer } from './mailer/console.mailer';
import { MAILER, type MailerPort } from './mailer/mailer.port';
import { TenantLinkService } from './mailer/tenant-link.service';
import { PasswordChangeService } from './password-change.service';
import { PasswordController } from './password.controller';
import { PasswordResetService } from './password-reset.service';
import { LoginThrottleService } from './login-throttle.service';
import { PasswordService } from './password.service';
import { RealtimeTicketService } from './realtime-ticket.service';
import { RealtimeTicketStore } from './realtime-ticket.store';
import { SessionCacheService } from './session-cache.service';
import { SessionController } from './session.controller';
import { SessionPrincipalSource } from './session-principal.source';
import { SessionReplayProbe } from './session-replay.probe';
import { SessionService } from './session.service';
import { UserInvitesController } from './user-invites.controller';

/**
 * Authentication, the session lifecycle, and the flows that change a credential
 * (TAR-39's L2 access layer, `IdentityModule`).
 *
 * Deliberately **not** `RbacModule`: this module answers *who is calling*, and
 * that one answers *what they may do*. Nothing here imports the permission
 * vocabulary beyond `permissionsForRole`, which is a pure function in the
 * contract — so the principal can carry materialised permissions without either
 * module depending on the other.
 *
 * One module rather than several, because `PasswordService` is the hasher
 * login, reset and invite acceptance must all use, and `SessionService` is the
 * one thing that mints a session: a second argon2 configuration is how a stored
 * hash stops verifying after a deploy, and a second way to write a `sessions`
 * row is how two of them come to disagree about the token shape or the expiry.
 * Extend this module; do not open a parallel one.
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
 *   * `LoginThrottleService` owns the lockout columns, and `UsersService` calls
 *     it for `POST /users/{id}/unlock` — so the three columns are written by
 *     one file rather than by whichever service happens to need them.
 *   * `RealtimeTicketService` is what TAR-69's Socket.IO gateway calls to spend
 *     a handshake ticket, so the single-use rule lives beside the code that
 *     issued it rather than being restated in the gateway.
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

/**
 * Which mailer a deployment gets.
 *
 * `ConsoleMailer` renders the reset link — a live credential — into the log,
 * which is exactly what makes the flow testable with no vendor account and
 * exactly what must never happen in a deployed environment's log aggregator.
 * The choice is therefore made once, here, at boot, rather than left to whoever
 * wires a module later.
 *
 * ⚠️ This binding is the seam TAR-41 replaces when a provider is chosen
 * (TAR-53, open question 2). Until then a deployed environment cannot deliver
 * invite or reset email at all, and `UndeliverableMailer` says so on every
 * attempt instead of failing quietly.
 */
const mailerProvider: Provider = {
  provide: MAILER,
  inject: [ConfigService, TenantLinkService],
  useFactory: (config: ConfigService, links: TenantLinkService): MailerPort => {
    const logger = new Logger(IdentityModule.name);

    if (config.get<string>('NODE_ENV') === 'production') {
      logger.warn(
        'No transactional email provider is configured: invite and password-reset email will be ' +
          'dropped. Wire an adapter behind the MAILER token (TAR-41).',
      );
      return new UndeliverableMailer();
    }

    return new ConsoleMailer(links);
  },
};

@Global()
@Module({
  // `EntitlementsModule` is not global, so it is imported rather than inherited:
  // the seat cap is enforced from `InviteService`, and the dependency reads in
  // this module's own list. It imports nothing back — the edge is one-way, so
  // there is no cycle (TAR-405).
  imports: [EntitlementsModule],
  controllers: [
    AuthController,
    SessionController,
    PasswordController,
    UserInvitesController,
    InvitesController,
  ],
  providers: [
    mailerProvider,
    AuthService,
    AuthRedisClient,
    InviteService,
    LoginThrottleService,
    TenantLinkService,
    PasswordService,
    PasswordResetService,
    PasswordChangeService,
    RealtimeTicketService,
    RealtimeTicketStore,
    SessionService,
    SessionCacheService,
    SessionPrincipalSource,
    SessionReplayProbe,
    ApiExceptionFilter,
  ],
  exports: [
    // One Redis connection for every throttle in the product. `SignupModule`'s
    // is the second reader (TAR-405) and opening its own client would double the
    // connection count for a counter that shares this one's key space anyway.
    AuthRedisClient,
    LoginThrottleService,
    PasswordService,
    RealtimeTicketService,
    SessionService,
    SessionPrincipalSource,
    MAILER,
  ],
})
export class IdentityModule {}
