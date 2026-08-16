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
  EscalationAlertListQuerySchema,
  type CursorPage,
  type EscalationAlertListQuery,
  type EscalationAlertResponse,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { EscalationAlertService } from './escalation-alert.service';
import { translateTicketFailure } from './tickets.http';

/**
 * The supervisor's escalation queue (TAR-32, ADR 0011 decision 5).
 *
 * Mirrors `SlaAlertsController` route for route, so there is one shape to learn
 * — and the reasoning is the same one, not a second copy of it.
 *
 * ## `ticket:read`, not a new `_all` permission
 *
 * Every row names its recipient, and `EscalationAlertService` adds
 * `recipient_user_id = principal.userId` on top of RLS. An agent may call this
 * and gets an empty page, which is the whole of the role-scoping requirement,
 * enforced server-side rather than by hiding a button. A dedicated permission
 * would say the same thing twice and give a supervisor a way to be granted
 * somebody else's queue.
 *
 * An alert belonging to another principal answers **404, not 403** — 0002's rule
 * that a 403 confirms the id exists, applied to a resource whose whole point is
 * that it was addressed to one person.
 *
 * ## In `TicketsModule` rather than beside `sla-alerts`
 *
 * An escalation is a ticket event with recipients, and its writer is
 * `TicketCommandService`. `SlaModule` is L4 and this is L3, so the alternative
 * would be a module edge pointing the wrong way — and the two surfaces share
 * nothing but a table.
 */
@Controller({ path: 'escalation-alerts', version: '1' })
@UseFilters(ApiExceptionFilter)
export class EscalationAlertsController {
  constructor(private readonly alerts: EscalationAlertService) {}

  @Get()
  @RequirePermission('ticket:read')
  list(
    @Query(new ZodValidationPipe(EscalationAlertListQuerySchema)) query: EscalationAlertListQuery,
  ): Promise<CursorPage<EscalationAlertResponse>> {
    return this.alerts.list(query).catch(translateTicketFailure);
  }

  /**
   * `POST /api/v1/escalation-alerts/{id}/acknowledge` — 200, and idempotent.
   *
   * A second call returns the same row with the original `acknowledged_at`;
   * nothing is a 409. A sub-resource POST rather than a `PATCH` of the
   * timestamp, per 0002's convention for a non-CRUD verb — and because the
   * timestamp is the server's to decide, not a value a client may name.
   */
  @Post(':id/acknowledge')
  @RequirePermission('ticket:read')
  @HttpCode(HttpStatus.OK)
  acknowledge(@Param('id', alertIdPipe()) id: string): Promise<EscalationAlertResponse> {
    return this.alerts.acknowledge(id).catch(translateTicketFailure);
  }
}

function alertIdPipe(): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      new ApiException('validation_failed', 'The escalation alert id must be a UUID.', [
        { path: 'id', message: 'Must be a UUID.' },
      ]),
  });
}
