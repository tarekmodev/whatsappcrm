import { Body, Controller, Get, Patch, UseFilters } from '@nestjs/common';
import {
  AssignmentSettingsUpdateInputSchema,
  type AssignmentSettingsResponse,
  type AssignmentSettingsUpdateInput,
  type OwnAssignmentCapacityResponse,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { AnyPrincipal, RequirePermission } from '../rbac/require-permission.decorator';
import { AssignmentSettingsService } from './assignment-settings.service';

/**
 * The cap-editing surface 0008 specified and nobody owned until TAR-384
 * (amendment 4).
 *
 * Behind the global pipeline like every other tenant controller — no guard is
 * declared here, and since TAR-58 that is what being fully protected looks like.
 * `PermissionGuard` denies by default, so every route states its permission,
 * including the one that needs none.
 *
 * `assignment_rule:read` / `assignment_rule:write`, not `user:update` and not
 * `tenant:settings`. 0008 decision 4 draws that line: setting how much work
 * reaches a colleague is the same act as writing a routing rule, so routing it
 * through `user:update` would mean anyone who may edit a display name may also
 * quietly stop work reaching somebody — while `tenant:settings` is admin-only,
 * and tuning workload is a supervisor's daily job.
 *
 * **This resource is the tenant default only.** The per-agent override is a
 * column on `users` and is written through `PATCH /api/v1/users/{id}`, which is
 * the resource that owns the row; a roster here would grow without bound with
 * tenant headcount and would re-implement the filtering and cursor paging
 * `GET /api/v1/users` already has.
 */
@Controller({ path: 'assignment-settings', version: '1' })
@UseFilters(ApiExceptionFilter)
export class AssignmentSettingsController {
  constructor(private readonly settings: AssignmentSettingsService) {}

  /** `GET /api/v1/assignment-settings` — the tenant-wide default. */
  @Get()
  @RequirePermission('assignment_rule:read')
  read(): Promise<AssignmentSettingsResponse> {
    return this.settings.read();
  }

  /**
   * `GET /api/v1/assignment-settings/me` — the caller's own cap and load.
   *
   * `@AnyPrincipal()`: the resource *is* the caller, and the parent story's
   * assumption is that an agent may view the limit being applied to them. There
   * is no write counterpart, which is the other half of that assumption.
   *
   * Declared before any `:id` route — there is none today, and this line is what
   * keeps `me` from being read as a user id the day somebody adds one. Nest
   * matches in declaration order; `users/me/availability` carries the same note
   * for the same reason.
   */
  @Get('me')
  @AnyPrincipal()
  readOwn(): Promise<OwnAssignmentCapacityResponse> {
    return this.settings.readOwn();
  }

  /**
   * `PATCH /api/v1/assignment-settings` — move the tenant default.
   *
   * One required field rather than a partial: the resource has exactly one
   * writable value today, so an empty body would be a silent no-op answering
   * 200. It reads as `validation_failed` naming
   * `defaultMaxConcurrentTickets` instead.
   */
  @Patch()
  @RequirePermission('assignment_rule:write')
  update(
    @Body(new ZodValidationPipe(AssignmentSettingsUpdateInputSchema))
    input: AssignmentSettingsUpdateInput,
  ): Promise<AssignmentSettingsResponse> {
    return this.settings.update(input);
  }
}
