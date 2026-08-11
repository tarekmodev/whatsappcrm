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
import {
  InviteAcceptInputSchema,
  InviteLookupInputSchema,
  type InviteAcceptInput,
  type InviteLookupInput,
  type InvitePreviewResponse,
  type SessionResponse,
} from '@whatsappcrm/contracts';
import type { Request, Response } from 'express';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import type { Env } from '../config/env.schema';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { HostTenantGuard } from '../tenancy/host-tenant.guard';
import { translateIdentityFailure } from './identity.http';
import { InviteService } from './invite.service';
import { isSecureCookieConfigured, setSessionCookie } from './session-cookie';

/**
 * The two routes an invitee reaches before they have an account (ADR 0005,
 * "Public — no session required").
 *
 * `HostTenantGuard` alone: there is no session to resolve, but the **tenant is
 * still established from the request host** before anything runs. That is what
 * lets both routes read and write through `TenantPrisma` under row-level
 * security like every other query in the system, instead of reaching for the
 * unscoped client — a token issued by tenant A and presented at tenant B's
 * address matches zero rows rather than being compared in code.
 *
 * Both take the token in the **body of a POST**, never in the path of a `GET`. A
 * live credential in a URL is written into every access log, proxy log and
 * `Referer` header between the browser and the handler; the emailed link keeps it
 * in the URL *fragment*, which browsers never transmit at all.
 */
@Controller({ path: 'invites', version: '1' })
@UseGuards(HostTenantGuard)
@UseFilters(ApiExceptionFilter)
export class InvitesController {
  private readonly cookieSecure: boolean;

  constructor(
    private readonly invites: InviteService,
    config: ConfigService<Env, true>,
  ) {
    this.cookieSecure = isSecureCookieConfigured(config.get('SESSION_COOKIE_SECURE'));
  }

  /**
   * `POST /api/v1/invites/lookup` — what the accept screen renders before the
   * invitee types anything.
   */
  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  lookup(
    @Body(new ZodValidationPipe(InviteLookupInputSchema)) input: InviteLookupInput,
  ): Promise<InvitePreviewResponse> {
    return this.invites.preview(input.token).catch(translateIdentityFailure);
  }

  /**
   * `POST /api/v1/invites/accept` — set a password, get an account and a session.
   *
   * The body carries a token, a display name and a password. It carries no
   * tenant and no role, and could not: the tenant comes from the host and the
   * role from the invitation the admin wrote.
   */
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @Body(new ZodValidationPipe(InviteAcceptInputSchema)) input: InviteAcceptInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const accepted = await this.invites
      .accept(input, {
        // Forensics on the session row. `request.ip` is the socket address —
        // `trust proxy` is off, so a client cannot forge it through a header.
        ipAddress: request.ip ?? null,
        userAgent: request.header('user-agent') ?? null,
      })
      .catch(translateIdentityFailure);

    setSessionCookie(response, this.cookieSecure, accepted.sessionToken);

    // The token is in the `Set-Cookie` header and nowhere else — never in the
    // body, which is script-readable and lands in browser devtools history.
    return { user: accepted.principal };
  }
}
