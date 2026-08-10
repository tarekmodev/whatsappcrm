import {
  Body,
  Controller,
  Delete,
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
  AvailabilityUpdateInputSchema,
  InviteCreateInputSchema,
  UserListQuerySchema,
  UserParamsSchema,
  UserUpdateInputSchema,
  type AvailabilityUpdateInput,
  type CursorPage,
  type InviteCreateInput,
  type InviteResponse,
  type UserListQuery,
  type UserParams,
  type UserResponse,
  type UserUpdateInput,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { AnyPrincipal, RequirePermission } from '../rbac/require-permission.decorator';
import { PermissionGuard } from '../rbac/permission.guard';
import { PrincipalGuard } from '../rbac/principal.guard';
import { HostTenantGuard } from '../tenancy/host-tenant.guard';
import { translatePeopleFailure } from './people.http';
import { UsersService } from './users.service';

/**
 * The tenant's people (TAR-22, TAR-39 endpoint table).
 *
 * The three guards are declared on the controller rather than per route, in the
 * order the pipeline needs them: **where** the request is (`HostTenantGuard`,
 * from the host), **who** is making it (`PrincipalGuard`), then **may they**
 * (`PermissionGuard`). A route added later inherits all three; forgetting one is
 * not possible by omission, only by deliberately overriding.
 *
 * `PermissionGuard` denies by default, so every route below states its
 * permission — including the one that needs none, which says so out loud.
 */
@Controller({ path: 'users', version: '1' })
@UseGuards(HostTenantGuard, PrincipalGuard, PermissionGuard)
@UseFilters(ApiExceptionFilter)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** `GET /api/v1/users` — the people list, tenant-wide for every role. */
  @Get()
  @RequirePermission('user:read')
  list(
    @Query(new ZodValidationPipe(UserListQuerySchema)) query: UserListQuery,
  ): Promise<CursorPage<UserResponse>> {
    return this.users.list(query);
  }

  /**
   * `POST /api/v1/users/invites` — invite somebody into the tenant.
   *
   * `user:invite` gets you here; what `role` you may put in the body is a
   * second question the service answers, because a supervisor holding this
   * permission may invite an agent and only an agent.
   */
  @Post('invites')
  @RequirePermission('user:invite')
  @HttpCode(HttpStatus.CREATED)
  invite(
    @Body(new ZodValidationPipe(InviteCreateInputSchema)) input: InviteCreateInput,
  ): Promise<InviteResponse> {
    return this.users.invite(input).catch(translatePeopleFailure);
  }

  /**
   * `PATCH /api/v1/users/me/availability` — the caller's own availability.
   *
   * Declared before `:id` so Express matches the literal path first; otherwise
   * `me` is read as a user id and the request fails validation.
   */
  @Patch('me/availability')
  @AnyPrincipal()
  setOwnAvailability(
    @Body(new ZodValidationPipe(AvailabilityUpdateInputSchema)) input: AvailabilityUpdateInput,
  ): Promise<UserResponse> {
    return this.users.setOwnAvailability(input.availability).catch(translatePeopleFailure);
  }

  /**
   * `PATCH /api/v1/users/{id}` — name, role, status, teams.
   *
   * The route requires `user:update`; a body carrying `role` additionally
   * requires `user:set_role`, which the service enforces because the guard's
   * metadata is static and this condition is not. A caller without it is
   * refused rather than served with the field dropped.
   */
  @Patch(':id')
  @RequirePermission('user:update')
  update(
    @Param(new ZodValidationPipe(UserParamsSchema)) params: UserParams,
    @Body(new ZodValidationPipe(UserUpdateInputSchema)) input: UserUpdateInput,
  ): Promise<UserResponse> {
    return this.users.update(params.id, input).catch(translatePeopleFailure);
  }

  /** `DELETE /api/v1/users/{id}` — admin only, and refused where it would erase history. */
  @Delete(':id')
  @RequirePermission('user:remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param(new ZodValidationPipe(UserParamsSchema)) params: UserParams): Promise<void> {
    await this.users.remove(params.id).catch(translatePeopleFailure);
  }
}
