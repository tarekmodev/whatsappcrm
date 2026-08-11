import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseFilters,
} from '@nestjs/common';
import {
  InviteCreateInputSchema,
  InviteListQuerySchema,
  InviteParamsSchema,
  type CursorPage,
  type InviteCreateInput,
  type InviteListQuery,
  type InviteParams,
  type InviteResponse,
} from '@whatsappcrm/contracts';
import type { Response } from 'express';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { translateIdentityFailure } from './identity.http';
import { InviteService } from './invite.service';

/**
 * Managing invitations from inside the tenant (ADR 0005, "Tenant
 * administration").
 *
 * No guard is declared: since TAR-58 the three that protect these routes —
 * **where** the request is (`HostTenantGuard`), **who** is making it
 * (`PrincipalGuard`), then **may they** (`PermissionGuard`) — are installed
 * application-wide by `RequestPipelineModule`, in that order. Each route states
 * only the permission it wants, and a route added later is closed until it does.
 *
 * `user:invite` gets you here; what `role` the body may carry is a second
 * question the service answers, because a caller holding this permission but not
 * `user:set_role` may invite an agent and only an agent.
 */
@Controller({ path: 'users/invites', version: '1' })
@UseFilters(ApiExceptionFilter)
export class UserInvitesController {
  constructor(private readonly invites: InviteService) {}

  /**
   * `POST /api/v1/users/invites` — invite somebody, or refresh the invitation
   * they already have.
   *
   * **201 when a row was written, 200 when a live one was refreshed**, matching
   * the convention `POST /admin/tenants` already set for an idempotent create.
   * Re-inviting is never a conflict: an invitation that lapsed still occupies the
   * partial unique index, so failing would leave the address un-invitable by any
   * self-service path.
   */
  @Post()
  @RequirePermission('user:invite')
  async invite(
    @Body(new ZodValidationPipe(InviteCreateInputSchema)) input: InviteCreateInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InviteResponse> {
    const { invite, created } = await this.invites.create(input).catch(translateIdentityFailure);

    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);

    return invite;
  }

  /** `GET /api/v1/users/invites` — who has been invited, and which links still work. */
  @Get()
  @RequirePermission('user:read')
  list(
    @Query(new ZodValidationPipe(InviteListQuerySchema)) query: InviteListQuery,
  ): Promise<CursorPage<InviteResponse>> {
    return this.invites.list(query).catch(translateIdentityFailure);
  }

  /**
   * `POST /api/v1/users/invites/{id}/resend` — a new token for the same
   * invitation, which retires the previous link.
   */
  @Post(':id/resend')
  @RequirePermission('user:invite')
  @HttpCode(HttpStatus.OK)
  resend(
    @Param(new ZodValidationPipe(InviteParamsSchema)) params: InviteParams,
  ): Promise<InviteResponse> {
    return this.invites.resend(params.id).catch(translateIdentityFailure);
  }

  /**
   * `DELETE /api/v1/users/invites/{id}` — withdraw a pending invitation.
   *
   * The invitee's `invited` account is left in place: removing an account is
   * `DELETE /api/v1/users/{id}`, which needs the admin-only `user:remove`.
   */
  @Delete(':id')
  @RequirePermission('user:invite')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param(new ZodValidationPipe(InviteParamsSchema)) params: InviteParams,
  ): Promise<void> {
    await this.invites.revoke(params.id).catch(translateIdentityFailure);
  }
}
