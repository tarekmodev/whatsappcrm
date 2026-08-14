import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import {
  SlaAlertListQuerySchema,
  type CursorPage,
  type SlaAlertListQuery,
  type SlaAlertResponse,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { SlaAlertService } from './sla-alert.service';
import { translateSlaFailure } from './sla.http';

/**
 * The supervisor's alert queue (TAR-26, 0006's endpoint surface).
 *
 * ## `ticket:read`, not a new `_all` permission
 *
 * Every row names its recipient, and the service adds
 * `recipient_user_id = principal.userId` on top of RLS. An agent may call this
 * and gets an empty page — which is the whole of the role-scoping requirement,
 * enforced server-side rather than by hiding a button. A dedicated permission
 * would say the same thing twice and give a supervisor a way to be granted
 * somebody else's queue.
 *
 * An alert belonging to another principal answers **404, not 403** — 0002's rule
 * that a 403 confirms the id exists, applied to a resource whose whole point is
 * that it was addressed to one person.
 */
@Controller({ path: 'sla-alerts', version: '1' })
@UseFilters(ApiExceptionFilter)
export class SlaAlertsController {
  constructor(private readonly alerts: SlaAlertService) {}

  @Get()
  @RequirePermission('ticket:read')
  list(
    @Query(new ZodValidationPipe(SlaAlertListQuerySchema)) query: SlaAlertListQuery,
  ): Promise<CursorPage<SlaAlertResponse>> {
    return this.alerts.list(query).catch(translateSlaFailure);
  }

  /**
   * `POST /api/v1/sla-alerts/{id}/acknowledge` — 200, and idempotent.
   *
   * A second call returns the same row with the original `acknowledged_at`;
   * nothing is a 409. A sub-resource POST rather than a `PATCH` of the timestamp,
   * per 0002's convention for a non-CRUD verb — and because the timestamp is the
   * server's to decide, not a value a client may name.
   */
  @Post(':id/acknowledge')
  @RequirePermission('ticket:read')
  @HttpCode(HttpStatus.OK)
  acknowledge(@Param('id', alertIdPipe()) id: string): Promise<SlaAlertResponse> {
    return this.alerts.acknowledge(id).catch(translateSlaFailure);
  }
}

function alertIdPipe(): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      new ApiException('validation_failed', 'The SLA alert id must be a UUID.', [
        { path: 'id', message: 'Must be a UUID.' },
      ]),
  });
}
