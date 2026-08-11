import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  TeamCreateInputSchema,
  TeamListQuerySchema,
  TeamParamsSchema,
  TeamUpdateInputSchema,
  type CursorPage,
  type TeamCreateInput,
  type TeamListQuery,
  type TeamParams,
  type TeamResponse,
  type TeamUpdateInput,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { PermissionGuard } from '../rbac/permission.guard';
import { PrincipalGuard } from '../rbac/principal.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { HostTenantGuard } from '../tenancy/host-tenant.guard';
import { translatePeopleFailure } from './people.http';
import { TeamsService } from './teams.service';

/**
 * Teams (TAR-22 AC2). Same guard stack and ordering as `UsersController`.
 *
 * `team:read` for every role, because an agent needs the names of the teams
 * their conversations are routed to; `team:write` for supervisor and admin,
 * which is what TAR-22 AC3's "manage all agents/teams in their tenant" asks for.
 */
@Controller({ path: 'teams', version: '1' })
@UseGuards(HostTenantGuard, PrincipalGuard, PermissionGuard)
@UseFilters(ApiExceptionFilter)
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @RequirePermission('team:read')
  list(
    @Query(new ZodValidationPipe(TeamListQuerySchema)) query: TeamListQuery,
  ): Promise<CursorPage<TeamResponse>> {
    return this.teams.list(query);
  }

  @Post()
  @RequirePermission('team:write')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(TeamCreateInputSchema)) input: TeamCreateInput,
  ): Promise<TeamResponse> {
    return this.teams.create(input).catch(translatePeopleFailure);
  }

  /**
   * `PATCH /api/v1/teams/{id}` — rename, re-describe, or replace the membership.
   *
   * Additive to TAR-39's published table; see `TeamsService.update` for why it
   * has to exist for TAR-22 AC3 to hold.
   */
  @Patch(':id')
  @RequirePermission('team:write')
  update(
    @Param(new ZodValidationPipe(TeamParamsSchema)) params: TeamParams,
    @Body(new ZodValidationPipe(TeamUpdateInputSchema)) input: TeamUpdateInput,
  ): Promise<TeamResponse> {
    return this.teams.update(params.id, input).catch(translatePeopleFailure);
  }
}
