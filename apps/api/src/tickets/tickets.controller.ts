import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import {
  TicketAssignInputSchema,
  TicketListQuerySchema,
  TicketUpdateInputSchema,
  type CursorPage,
  type TicketAssignInput,
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
 * The ticket queue and the two writes into a ticket (TAR-25 and TAR-23, 0002
 * endpoint table, ruled by 0006 and 0008).
 *
 * It declares no guards. `RequestPipelineModule` runs all three on every route
 * in the application (TAR-58) — where the request is, who is making it, then
 * whether they may — so every route below states only its permission.
 *
 * ## The permissions
 *
 * `ticket:read` on both reads, widened by `ticket:read_all` through
 * `narrowScope` on the list and `isVisible` on the detail. `ticket:update` on
 * the PATCH and `ticket:assign` on the assign, as 0002 publishes them.
 *
 * `ticket:assign` is supervisor-and-above, and every role holding it also holds
 * `ticket:read_all` (0004) — which is what makes the visibility check in front
 * of the write reachable for an *unassigned* flagged ticket rather than a 404 on
 * the one queue the endpoint exists to empty.
 *
 * **`ticket:close` is not on the decorator**, and that is deliberate rather than
 * an omission: a transition into `resolved` or `closed` needs it *in addition*
 * to `ticket:update`, and only the request body says whether this PATCH is such
 * a transition. A per-route guard cannot read the body, so the check lives in
 * `TicketCommandService` — one `if`, refused with `forbidden`. Declaring both
 * here instead would make re-prioritising a ticket require the right to close
 * one.
 *
 * ## One PATCH, not a status sub-route — and assignment beside it, not in it
 *
 * Unlike `PATCH /conversations/{id}/status`. A ticket's status change and its
 * re-prioritisation are one triage action an agent takes in one form, 0002
 * already publishes the combined PATCH, and the console already types against
 * `TicketUpdateInput`. Splitting it would be a contract amendment that buys
 * nothing.
 *
 * Assignment is the reverse case and gets its own route, as 0002 and 0008 both
 * publish it: a different permission, a different actor, and a write that moves
 * the routing columns as well as the assignment ones. Folding it into the PATCH
 * would make re-prioritising a ticket and taking it off a colleague the same
 * right.
 *
 * No `Idempotency-Key` on either: 0002 requires the header on sends and billing
 * only. Both routes carry the target state rather than a delta, so a replay is
 * the documented no-op and not a second effect.
 *
 * ## What is not here
 *
 * `GET /tickets/{id}/events` (TAR-32), additive to this controller when it
 * lands.
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

  /**
   * `POST /api/v1/tickets/{id}/assign` — the supervisor's manual placement
   * (TAR-23, 0008 decision 3), and the write that takes a flagged ticket out of
   * the deferred queue.
   *
   * 200 rather than 201: nothing is created, and the body is the ticket as it
   * now stands — the same shape the PATCH and the detail read publish, so the
   * console can put the response straight back into its cache.
   *
   * At least one of `userId` and `teamId` is required by the schema's `.refine`,
   * and each may be `null` to clear that column. `TicketCommandService.assign`
   * owns what that means for the routing columns.
   */
  @Post(':id/assign')
  @RequirePermission('ticket:assign')
  @HttpCode(HttpStatus.OK)
  assign(
    @Param('id', ticketIdPipe()) id: string,
    @Body(new ZodValidationPipe(TicketAssignInputSchema)) input: TicketAssignInput,
  ): Promise<TicketResponse> {
    return this.commands.assign(id, input).catch(translateTicketFailure);
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
