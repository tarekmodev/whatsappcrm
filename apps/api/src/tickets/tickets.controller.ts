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
  TicketListQuerySchema,
  TicketUpdateInputSchema,
  type CursorPage,
  type TicketListQuery,
  type TicketResponse,
  type TicketUpdateInput,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { TicketCommandService } from './ticket-command.service';
import { TicketQueryService } from './ticket-query.service';
import { translateTicketFailure } from './tickets.http';

/**
 * The ticket queue and the one write into a ticket (TAR-25, 0002 endpoint
 * table, ruled by 0006).
 *
 * It declares no guards. `RequestPipelineModule` runs all three on every route
 * in the application (TAR-58) — where the request is, who is making it, then
 * whether they may — so every route below states only its permission.
 *
 * ## The permissions
 *
 * `ticket:read` on both reads, widened by `ticket:read_all` through
 * `narrowScope` on the list and `isVisible` on the detail. `ticket:update` on
 * the PATCH, as 0002 publishes it.
 *
 * **`ticket:close` is not on the decorator**, and that is deliberate rather than
 * an omission: a transition into `resolved` or `closed` needs it *in addition*
 * to `ticket:update`, and only the request body says whether this PATCH is such
 * a transition. A per-route guard cannot read the body, so the check lives in
 * `TicketCommandService` — one `if`, refused with `forbidden`. Declaring both
 * here instead would make re-prioritising a ticket require the right to close
 * one.
 *
 * ## One PATCH, not a status sub-route
 *
 * Unlike `PATCH /conversations/{id}/status`. A ticket's status change and its
 * re-prioritisation are one triage action an agent takes in one form, 0002
 * already publishes the combined PATCH, and the console already types against
 * `TicketUpdateInput`. Splitting it would be a contract amendment that buys
 * nothing.
 *
 * No `Idempotency-Key` either: 0002 requires the header on sends and billing
 * only, and a PATCH carries the target state — a replay is the documented no-op,
 * not a second effect.
 *
 * ## What is not here
 *
 * `POST /tickets/{id}/assign` (TAR-23) and `GET /tickets/{id}/events` (TAR-32).
 * Both are additive to this controller when they land.
 *
 * ## Ids are validated as UUIDs before anything looks them up
 *
 * A path parameter that is not a UUID names nothing, and it reaches a `@db.Uuid`
 * column as a driver error rather than a filter — a 500 for input that deserves
 * a 400.
 */
@Controller({ path: 'tickets', version: '1' })
@UseFilters(ApiExceptionFilter)
export class TicketsController {
  constructor(
    private readonly tickets: TicketQueryService,
    private readonly commands: TicketCommandService,
  ) {}

  /**
   * `GET /api/v1/tickets` — the queue.
   *
   * No `status` means the active statuses, ordered urgent-first. See
   * `TicketQueryService` for why there is no sort parameter.
   */
  @Get()
  @RequirePermission('ticket:read')
  list(
    @Query(new ZodValidationPipe(TicketListQuerySchema)) query: TicketListQuery,
  ): Promise<CursorPage<TicketResponse>> {
    return this.tickets.list(query).catch(translateTicketFailure);
  }

  @Get(':id')
  @RequirePermission('ticket:read')
  get(@Param('id', ticketIdPipe()) id: string): Promise<TicketResponse> {
    return this.tickets.get(id).catch(translateTicketFailure);
  }

  /** `PATCH /api/v1/tickets/{id}` — subject, status, priority. At least one of them. */
  @Patch(':id')
  @RequirePermission('ticket:update')
  update(
    @Param('id', ticketIdPipe()) id: string,
    @Body(new ZodValidationPipe(TicketUpdateInputSchema)) input: TicketUpdateInput,
  ): Promise<TicketResponse> {
    return this.commands.update(id, input).catch(translateTicketFailure);
  }
}

function ticketIdPipe(): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      new ApiException('validation_failed', 'The ticket id must be a UUID.', [
        { path: 'id', message: 'Must be a UUID.' },
      ]),
  });
}
