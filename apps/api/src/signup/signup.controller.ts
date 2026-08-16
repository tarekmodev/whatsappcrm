import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SignupInputSchema,
  SignupResendInputSchema,
  SignupVerifyInputSchema,
  SlugAvailabilityQuerySchema,
  type SignupAcceptedResponse,
  type SignupCompletedResponse,
  type SignupInput,
  type SignupResendInput,
  type SignupVerifyInput,
  type SlugAvailabilityQuery,
  type SlugAvailabilityResponse,
} from '@whatsappcrm/contracts';
import type { Request, Response } from 'express';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { PublicPlatformRoute } from '../common/request-pipeline/route-access';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { isSecureCookieConfigured, setSessionCookie } from '../identity/session-cookie';
import type { ProvisionedTenant } from '../tenancy/tenant-provisioning.service';
import { translateSignupFailure } from './signup.http';
import { TenantSignupService } from './tenant-signup.service';

/**
 * Public self-signup (TAR-405, ADR 0009 decision 3).
 *
 * ⚠️ **The only `@PublicPlatformRoute()` controller in the product**: outside
 * tenancy, and unauthenticated. There is no tenant to resolve — the tenant does
 * not exist until `verify` runs — and no session to resolve a principal from, so
 * every guard in the pipeline stands down and what is left protecting these
 * routes is stated in the service: a feature flag, three rate limits, and the
 * fact that nothing here grants authority until an emailed token comes back.
 *
 * The posture is declared on the class rather than per route so a route added
 * later inherits it visibly, and `route-posture.spec.ts` fails in CI if one ever
 * declares two.
 */
@Controller({ path: 'signup', version: '1' })
@PublicPlatformRoute()
@UseFilters(ApiExceptionFilter)
export class SignupController {
  private readonly cookieSecure: boolean;

  constructor(
    private readonly signup: TenantSignupService,
    config: ConfigService,
  ) {
    this.cookieSecure = isSecureCookieConfigured(config.get('SESSION_COOKIE_SECURE'));
  }

  /**
   * `POST /api/v1/signup` — record the signup and mail the verification link.
   *
   * `202`, not `201`: nothing has been created that the caller can go and look
   * at. The tenant does not exist yet and the pending row is deliberately not
   * addressable — a resource the caller could `GET` would be an oracle for which
   * addresses have a signup in flight.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async request(
    @Body(new ZodValidationPipe(SignupInputSchema)) input: SignupInput,
    @Req() request: Request,
  ): Promise<SignupAcceptedResponse> {
    const accepted = await this.signup
      .request(input, request.ip ?? null)
      .catch((error: unknown) => translateSignupFailure(error));

    return { email: accepted.email, expiresAt: accepted.expiresAt.toISOString() };
  }

  /**
   * `POST /api/v1/signup/verify` — spend the token, provision the tenant, sign
   * the new admin in.
   *
   * `201`, unlike login's `200`: this one genuinely creates a resource the caller
   * did not have, and the body names it. The session token leaves in a
   * `Set-Cookie` header and appears in no response field and no log line.
   *
   * The cookie is set on the **platform** host, which is where this request
   * arrived, while `primaryHostname` in the body is the tenant's own subdomain.
   * The client redirects there and signs in again from the invite it already
   * holds — the console's job, and the reason the hostname is published here.
   */
  @Post('verify')
  @HttpCode(HttpStatus.CREATED)
  async verify(
    @Body(new ZodValidationPipe(SignupVerifyInputSchema)) input: SignupVerifyInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SignupCompletedResponse> {
    const completed = await this.signup
      .verify(input.token, {
        ipAddress: request.ip ?? null,
        userAgent: request.header('user-agent') ?? null,
      })
      .catch((error: unknown) => translateSignupFailure(error));

    setSessionCookie(response, this.cookieSecure, completed.sessionToken);

    return {
      tenant: toProvisionedTenant(completed.tenant),
      user: completed.principal,
      primaryHostname: completed.tenant.primaryHostname,
    };
  }

  /**
   * `POST /api/v1/signup/resend`.
   *
   * Always `202`, whether or not there was a signup to resend. An address with
   * nothing outstanding gets no mail and the same answer, because the
   * alternative is an oracle for which addresses have signed up.
   */
  @Post('resend')
  @HttpCode(HttpStatus.ACCEPTED)
  async resend(
    @Body(new ZodValidationPipe(SignupResendInputSchema)) input: SignupResendInput,
    @Req() request: Request,
  ): Promise<SignupAcceptedResponse> {
    const accepted = await this.signup
      .resend(input.email, request.ip ?? null)
      .catch((error: unknown) => translateSignupFailure(error));

    return { email: accepted.email, expiresAt: accepted.expiresAt.toISOString() };
  }

  /**
   * `GET /api/v1/signup/slug-available?slug=` — so the form can say "taken"
   * while the customer is still typing, rather than after they have gone to
   * check their inbox.
   */
  @Get('slug-available')
  async slugAvailable(
    @Query(new ZodValidationPipe(SlugAvailabilityQuerySchema)) query: SlugAvailabilityQuery,
    @Req() request: Request,
  ): Promise<SlugAvailabilityResponse> {
    return this.signup
      .slugAvailability(query.slug, request.ip ?? null)
      .catch((error: unknown) => translateSignupFailure(error));
  }
}

/**
 * Explicit rather than spread, so adding a column to the provisioning projection
 * cannot quietly add a field to a public, unauthenticated response — the same
 * reason `AdminTenantsController` maps this shape by hand.
 */
function toProvisionedTenant(tenant: ProvisionedTenant): SignupCompletedResponse['tenant'] {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    primaryHostname: tenant.primaryHostname,
    settings: { timezone: tenant.timezone, locale: tenant.locale },
    createdAt: tenant.createdAt.toISOString(),
  };
}
