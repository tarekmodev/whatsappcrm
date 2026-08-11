import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseFilters } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoginInputSchema, type LoginInput, type SessionResponse } from '@whatsappcrm/contracts';
import type { Request, Response } from 'express';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { Public } from '../common/request-pipeline/route-access';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { AuthService } from './auth.service';
import { AccountLockedError } from './identity.errors';
import { translateIdentityFailure } from './identity.http';
import { isSecureCookieConfigured, setSessionCookie } from './session-cookie';

/**
 * The one route that runs before anybody is signed in (TAR-53, "Public — no
 * session required").
 *
 * `@Public()` is declared on the class, not the route, and it stays a separate
 * controller from `SessionController` for that reason: the exemption is stated
 * once, so a route added here inherits it and a route added to
 * `SessionController` cannot pick it up by accident. Login genuinely cannot run
 * behind `PrincipalGuard`; mixing the two postures on one class is how a route
 * eventually ships with the wrong one.
 *
 * `HostTenantGuard` still runs — that is precisely what `@Public()` does *not*
 * turn off. Even an unauthenticated request has a tenant: it comes from the
 * request `Host`, which is why there is no tenant field anywhere in the login
 * contract for a caller to choose.
 */
@Controller({ path: 'auth', version: '1' })
@Public()
@UseFilters(ApiExceptionFilter)
export class AuthController {
  private readonly cookieSecure: boolean;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService,
  ) {
    this.cookieSecure = isSecureCookieConfigured(config.get('SESSION_COOKIE_SECURE'));
  }

  /**
   * `POST /api/v1/auth/login`.
   *
   * 200 rather than 201: it does create a session row, but the resource the
   * caller receives is themselves, and the credential leaves in a `Set-Cookie`
   * header rather than in the body. The token appears in **no** response
   * field and in no log line — the only place it exists outside the browser is
   * that header.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(LoginInputSchema)) input: LoginInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const { principal, issued } = await this.auth
      .login(input, {
        ipAddress: request.ip ?? null,
        userAgent: request.header('user-agent') ?? null,
      })
      .catch((error: unknown) => {
        // `Retry-After` is part of the 429 contract and the filter cannot add
        // it — it renders the envelope and knows nothing about lockout windows.
        // Set here, on the one path that has the number.
        if (error instanceof AccountLockedError) {
          response.setHeader('Retry-After', String(error.retryAfterSeconds));
        }

        return translateIdentityFailure(error);
      });

    setSessionCookie(response, this.cookieSecure, issued.token);

    return { user: principal };
  }
}
