import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LogoutInputSchema,
  SessionParamsSchema,
  type LogoutInput,
  type SessionListResponse,
  type SessionParams,
  type SessionResponse,
} from '@whatsappcrm/contracts';
import type { Response } from 'express';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { AnyPrincipal } from '../rbac/require-permission.decorator';
import { AuthService } from './auth.service';
import { translateIdentityFailure } from './identity.http';
import { clearSessionCookie, isSecureCookieConfigured } from './session-cookie';
import { SessionService } from './session.service';

/**
 * The caller's own session and devices (TAR-53, "Authenticated — own session
 * and credentials").
 *
 * It declares no guards, and since TAR-58 that is what "fully protected" looks
 * like: `RequestPipelineModule` runs **where** the request is
 * (`HostTenantGuard`), **who** is making it (`PrincipalGuard`) and **may they**
 * (`PermissionGuard`) on every route in the application, and this class opts out
 * of none of it.
 *
 * Every route here is `@AnyPrincipal()`, and that is a decision rather than an
 * omission: the resource *is* the caller. No permission gates reading your own
 * session or dropping your own device, and none should — a role that could not
 * sign itself out would be a role nobody could leave. `PermissionGuard` denies
 * a route with no metadata at all, so saying so out loud is the only way to say
 * it.
 *
 * Nothing here takes a user id from the caller. Every statement is scoped to
 * `principal.userId`, so there is no route through this controller to somebody
 * else's sessions, their IP addresses, or their devices.
 */
@Controller({ path: 'auth', version: '1' })
@UseFilters(ApiExceptionFilter)
export class SessionController {
  private readonly cookieSecure: boolean;

  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly tenantContext: TenantContextService,
    config: ConfigService,
  ) {
    this.cookieSecure = isSecureCookieConfigured(config.get('SESSION_COOKIE_SECURE'));
  }

  /**
   * `GET /api/v1/auth/session` — the frontend's bootstrap call, and the
   * refresh.
   *
   * There is no separate refresh endpoint, by design (TAR-53, decision 1):
   * the session slides on *use*, so any authenticated request — including this
   * one — pushes the idle deadline forward, at most once every five minutes per
   * session. A second credential to rotate would be a second credential to
   * store and leak, and the absolute cap is what actually bounds a stolen
   * cookie.
   *
   * Answers 401 rather than a null body when there is no session, so the client
   * has one branch instead of two. `PrincipalGuard` is what produces that.
   */
  @Get('session')
  @AnyPrincipal()
  currentSession(): SessionResponse {
    return { user: this.tenantContext.requirePrincipal() };
  }

  /**
   * `POST /api/v1/auth/logout` — ends this session, or all of them.
   *
   * Always 204 and always clears the cookie, including when the session was
   * already revoked: a logout that can fail is a logout button that sometimes
   * leaves people signed in.
   */
  @Post('logout')
  @AnyPrincipal()
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Body(new ZodValidationPipe(LogoutInputSchema)) input: LogoutInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth
      .logout(this.tenantContext.requirePrincipal(), input.allSessions)
      .catch(translateIdentityFailure);

    clearSessionCookie(response, this.cookieSecure);
  }

  /**
   * `GET /api/v1/auth/sessions` — the caller's live sessions, so they can spot
   * a device they do not recognise.
   *
   * A plain array rather than a `CursorPage`: the set is bounded by how many
   * devices one person signs in from, and paginating it would be ceremony. The
   * query still carries a limit — "naturally bounded" is not a promise the API
   * can make to a client.
   */
  @Get('sessions')
  @AnyPrincipal()
  listOwnSessions(): Promise<SessionListResponse> {
    return this.sessions.listOwn(this.tenantContext.requirePrincipal());
  }

  /**
   * `DELETE /api/v1/auth/sessions/{id}` — drop one device.
   *
   * Scoped to the caller inside the statement, so another user's id answers
   * `not_found` rather than revoking anything. Revoking the *current* session is
   * allowed and behaves like a logout, minus the cookie clear — the client
   * asked for a specific id, and second-guessing which one it meant would be
   * worse than honouring it.
   */
  @Delete('sessions/:id')
  @AnyPrincipal()
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeOwnSession(
    @Param(new ZodValidationPipe(SessionParamsSchema)) params: SessionParams,
  ): Promise<void> {
    await this.sessions
      .revokeOwn(this.tenantContext.requirePrincipal(), params.id)
      .catch(translateIdentityFailure);
  }
}
