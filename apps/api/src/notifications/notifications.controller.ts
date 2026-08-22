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
  NotificationListQuerySchema,
  type CursorPage,
  type NotificationListQuery,
  type NotificationResponse,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { NotificationService } from './notification.service';
import { translateNotificationFailure } from './notifications.http';

/**
 * The generalised inbox (TAR-27, 0002's REST table and 0009 decision 7).
 *
 * Mirrors `SlaAlertsController` and `EscalationAlertsController` route for
 * route, so there is one shape to learn — and the reasoning is theirs, not a
 * third copy of it. Those two stay exactly as published, as single-type views
 * over the same rows.
 *
 * ## `ticket:read`, not a new `_all` permission
 *
 * Every row names its recipient, and `NotificationService` adds
 * `recipient_user_id = principal.userId` on top of RLS. An agent may call this
 * and sees only what was addressed to them, which is the whole of the
 * role-scoping requirement, enforced server-side rather than by hiding a button.
 * A dedicated permission would say the same thing twice and give a supervisor a
 * way to be granted somebody else's inbox.
 *
 * A notification belonging to another principal answers **404, not 403** —
 * 0002's rule that a 403 confirms the id exists, applied to a resource whose
 * whole point is that it was addressed to one person.
 */
@Controller({ path: 'notifications', version: '1' })
@UseFilters(ApiExceptionFilter)
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @RequirePermission('ticket:read')
  list(
    @Query(new ZodValidationPipe(NotificationListQuerySchema)) query: NotificationListQuery,
  ): Promise<CursorPage<NotificationResponse>> {
    return this.notifications.list(query).catch(translateNotificationFailure);
  }

  /**
   * `POST /api/v1/notifications/{id}/acknowledge` — 200, and idempotent.
   *
   * A second call returns the same row with the original `acknowledged_at`;
   * nothing is a 409. A sub-resource POST rather than a `PATCH` of the
   * timestamp, per 0002's convention for a non-CRUD verb — and because the
   * timestamp is the server's to decide, not a value a client may name.
   */
  @Post(':id/acknowledge')
  @RequirePermission('ticket:read')
  @HttpCode(HttpStatus.OK)
  acknowledge(@Param('id', notificationIdPipe()) id: string): Promise<NotificationResponse> {
    return this.notifications.acknowledge(id).catch(translateNotificationFailure);
  }
}

function notificationIdPipe(): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      new ApiException('validation_failed', 'The notification id must be a UUID.', [
        { path: 'id', message: 'Must be a UUID.' },
      ]),
  });
}
