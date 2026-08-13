import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseFilters,
} from '@nestjs/common';
import {
  CursorPageQuerySchema,
  SlaPolicyUpdateInputSchema,
  type CursorPage,
  type CursorPageQuery,
  type SlaPolicyResponse,
  type SlaPolicyUpdateInput,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { SlaPolicyService } from './sla-policy.service';
import { translateSlaFailure } from './sla.http';

/**
 * The tenant's SLA configuration (TAR-26, 0006's endpoint surface).
 *
 * It declares no guards. `RequestPipelineModule` runs all three on every route
 * in the application — where the request is, who is making it, then whether they
 * may — so every route below states only its permission.
 *
 * **No POST and no DELETE at v1.** The row `TenantProvisioningService` seeds
 * satisfies TAR-26, and a create surface is only meaningful alongside the
 * per-priority policy UI that is out of scope. Turning SLA off is
 * `PATCH { isActive: false }`, which mirrors how a tenant is deactivated rather
 * than deleted, and leaves the row that running timers point at intact.
 *
 * `sla:read` and `sla:write` already exist in the shipped matrix and are already
 * granted to supervisor and admin. This story adds no permission and moves no
 * grant.
 */
@Controller({ path: 'sla-policies', version: '1' })
@UseFilters(ApiExceptionFilter)
export class SlaPoliciesController {
  constructor(private readonly policies: SlaPolicyService) {}

  @Get()
  @RequirePermission('sla:read')
  list(
    @Query(new ZodValidationPipe(CursorPageQuerySchema)) query: CursorPageQuery,
  ): Promise<CursorPage<SlaPolicyResponse>> {
    return this.policies.list(query).catch(translateSlaFailure);
  }

  @Get(':id')
  @RequirePermission('sla:read')
  get(@Param('id', policyIdPipe()) id: string): Promise<SlaPolicyResponse> {
    return this.policies.get(id).catch(translateSlaFailure);
  }

  /**
   * The one write. No `Idempotency-Key`: a `PATCH` of named fields to fixed
   * values is idempotent by construction — replaying it lands the row in the
   * same state — and 0002 requires the header on sends and billing operations,
   * not on every mutation.
   */
  @Patch(':id')
  @RequirePermission('sla:write')
  update(
    @Param('id', policyIdPipe()) id: string,
    @Body(new ZodValidationPipe(SlaPolicyUpdateInputSchema)) input: SlaPolicyUpdateInput,
  ): Promise<SlaPolicyResponse> {
    return this.policies.update(id, input).catch(translateSlaFailure);
  }
}

/**
 * A path parameter that is not a UUID names nothing, and it reaches a `@db.Uuid`
 * column as a driver error rather than a filter — a 500 for input that deserves
 * a 400.
 */
function policyIdPipe(): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      new ApiException('validation_failed', 'The SLA policy id must be a UUID.', [
        { path: 'id', message: 'Must be a UUID.' },
      ]),
  });
}
