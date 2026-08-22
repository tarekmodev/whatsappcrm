import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  AdminWebhookEventParamsSchema,
  type AdminWebhookEventParams,
  type AdminWebhookEventReplayResponse,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../../common/errors/api-exception.filter';
import { ApiException } from '../../common/errors/api.exception';
import { PlatformRoute } from '../../common/request-pipeline/route-access';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PlatformAdminGuard } from '../../tenancy/admin/platform-admin.guard';
import type { ReplayedWebhookEvent } from '../webhook-events.repository';
import { WebhookEventReplayService } from './webhook-event-replay.service';

/**
 * The platform-operator surface for parked inbound events (TAR-94).
 *
 * One route, and it is deliberately not the beginning of a webhook browser.
 * TAR-67 already gives an operator the query — `SELECT split_part(last_error,
 * ':', 1), count(*) FROM webhook_events WHERE status = 'failed' GROUP BY 1`, in
 * the README — and what it did not give them is a way to act on the answer
 * without hand-editing the row. This is that one action.
 *
 * ## Why it is not scoped by tenant slug
 *
 * Every other route on this surface names a tenant in its path and enters that
 * tenant's scope before touching anything, which is what keeps RLS bounding the
 * write. This one cannot, and the reason is the case it exists for: the flagship
 * parked event is an `unknown_phone_number_id`, a number connected *after* its
 * customers had already messaged it, and `webhook_events.tenant_id` on that row
 * is NULL. There is no tenant to enter.
 *
 * What replaces the scope is that the row this touches holds no tenant data to
 * leak — it is a raw provider payload the platform stored before it knew whose
 * it was, and the reset writes three columns of ingest bookkeeping. The tenant
 * boundary is enforced where it always was: by the processor, which re-resolves
 * `phone_number_id` → tenant on the next sweep and opens that tenant's scope
 * before writing a single message.
 *
 * `@PlatformRoute()` takes this out of the tenant pipeline — the operator is not
 * a user in any tenant — and `PlatformAdminGuard` is the authentication that
 * replaces it. The guard is on the class rather than per route, so a route added
 * later is protected by default rather than by remembering.
 */
@Controller({ path: 'admin/webhook-events', version: '1' })
@PlatformRoute()
@UseGuards(PlatformAdminGuard)
@UseFilters(ApiExceptionFilter)
export class AdminWebhookEventsController {
  constructor(private readonly replays: WebhookEventReplayService) {}

  /**
   * `POST /api/v1/admin/webhook-events/{webhookEventId}/replay` — reset a parked
   * event so the next sweep reprocesses it.
   *
   * `200` rather than `202`, even though the reprocessing itself is
   * asynchronous. What this call does is complete and durable when it answers:
   * the row is `received` and the trail row is committed. `202` would promise a
   * status resource to poll, and the thing to poll is `webhook_events.status`,
   * which the operator already has.
   *
   * **A repeat is a `409`, not a quiet `200`.** The second call has nothing to
   * do — the row it would reset is already `received`, or already being
   * processed — and answering `200` would tell an operator mid-incident that
   * they had just recovered a message when they had not. That is the same class
   * of quiet no-op as the sweeper's job-id collision TAR-67 fixed, and it is
   * worth a status code here for the same reason.
   */
  @Post(':webhookEventId/replay')
  @HttpCode(HttpStatus.OK)
  async replay(
    @Param(new ZodValidationPipe(AdminWebhookEventParamsSchema)) params: AdminWebhookEventParams,
  ): Promise<AdminWebhookEventReplayResponse> {
    const outcome = await this.replays.replay(params.webhookEventId);

    switch (outcome.kind) {
      case 'replayed':
        return toResponse(outcome.event);

      case 'not-found':
        throw new ApiException('not_found', 'No stored webhook event has that id.');

      case 'not-parked':
        // The status is named because the operator's next move depends on it:
        // `received` and `processing` mean the sweeper already has it and they
        // should wait, while `processed` means it succeeded and there is nothing
        // to recover. Naming it leaks nothing — this surface is authenticated
        // for the whole platform.
        throw new ApiException(
          'conflict',
          `This webhook event is ${outcome.status}, not parked, so there is nothing to replay. ` +
            'Only an event that failed ingestion can be replayed.',
        );
    }
  }
}

function toResponse(event: ReplayedWebhookEvent): AdminWebhookEventReplayResponse {
  return {
    id: event.id,
    provider: event.provider,
    // Always `received`: this is the state the reset put the row in, and the
    // reason the operator is told about it is that it is what the sweeper looks
    // for. Read off the contract's own vocabulary rather than the row, because
    // re-reading the row after the commit would report whatever the sweeper had
    // already done to it in the meantime.
    status: 'received',
    parkedError: event.parkedError,
    replayedAt: event.replayedAt.toISOString(),
  };
}
