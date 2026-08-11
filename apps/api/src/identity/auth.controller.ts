import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoginInputSchema, type LoginInput, type SessionResponse } from '@whatsappcrm/contracts';
import type { Request, Response } from 'express';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { HostTenantGuard } from '../tenancy/host-tenant.guard';
import { AuthService } from './auth.service';
import { AccountLockedError } from './identity.errors';
import { translateIdentityFailure } from './identity.http';
import { isSecureCookieConfigured, setSessionCookie } from './session-cookie';

/**
 * The one route that runs before anybody is signed in (TAR-53, "Public — no
 * session required").
 *
 * It is a separate controller from `SessionController` rather than a `@Public()`
 * route inside it for one reason: guards are declared once, on the controller,
 * so a route added later inherits them and forgetting one is not possible by
 * omission. Login genuinely cannot run behind `PrincipalGuard`, and mixing the
 * two on one class would mean per-route guard lists — which is how a route
 * eventually ships with the wrong ones.
 *
 * `HostTenantGuard` still runs. Even an unauthenticated request has a tenant:
 * it comes from the request `Host`, which is why there is no tenant field
 * anywhere in the login contract for a caller to choose.
 *
 * ⚠️ TAR-58 replaces this arrangement with a global `AuthGuard` and a
 * `@Public()` decorator, at which point this class keeps its guard and loses
 * nothing else.
 */
@Controller({ path: 'auth', version: '1' })
@UseGuards(HostTenantGuard)
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
