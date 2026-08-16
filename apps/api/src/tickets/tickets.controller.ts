import {
  Body,
  Controller,
  Get,
  Headers,
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
  IdSchema,
  TicketAssignInputSchema,
  TicketEscalateInputSchema,
  TicketEventListQuerySchema,
  TicketListQuerySchema,
  TicketUpdateInputSchema,
  type CursorPage,
  type TicketAssignInput,
  type TicketEscalateInput,
  type TicketEscalationResponse,
  type TicketEvent,
  type TicketEventListQuery,
  type TicketListQuery,
  type TicketResponse,
  type TicketUpdateInput,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { TicketCommandService } from './ticket-command.service';
import { TicketEventQueryService } from './ticket-event-query.service';
import { TicketQueryService } from './ticket-query.service';
import { translateTicketFailure } from './tickets.http';

/** Lower-case, because Express lower-cases every header name it indexes. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

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
 * `ticket:read` on every read, widened by `ticket:read_all` through
 * `narrowScope` on the list and `isVisible` on the detail and the event log.
 * `ticket:update` on the PATCH, `ticket:handoff` on the assign and
 * `ticket:escalate` on the escalate.
 *
 * **The assign route declares `ticket:handoff`, which is weaker than the
 * `ticket:assign` 0002 published** (TAR-32, ADR 0011 decision 2). Every role
 * holds `ticket:handoff`, so an agent can hand on the ticket they are working —
 * and `TicketCommandService.assign` applies the bound that `ticket:assign`
 * skips: they must hold the ticket, the target must be a teammate, and somebody
 * must still hold it afterwards. Declaring the stronger permission here instead
 * would 403 every agent before the service was reached, which is the whole of
 * what TAR-32's first acceptance criterion asks for.
 *
 * ⚠️ A route whose declared permission is weaker than one of its behaviours is
 * where authorization bugs live. The bound is asserted in
 * `ticket-handoff.int-spec.ts` against a real database rather than assumed from
 * this comment.
 *
 * `ticket:assign` is still supervisor-and-above, and every role holding it also
 * holds `ticket:read_all` (0004) — which is what makes the visibility check in
 * front of the write reachable for an *unassigned* flagged ticket rather than a
 * 404 on the one queue the endpoint exists to empty.
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
 * No `Idempotency-Key` on the PATCH or the assign: 0002 requires the header on
 * sends and billing only, and both routes carry the target state rather than a
 * delta, so a replay is the documented no-op and not a second effect.
 *
 * **`escalate` is the exception, and it takes the header as optional** (0011
 * decision 3). It is the first non-billing route in this API that genuinely
 * *creates* — every call appends an event and notifies people — so a retry after
 * a dropped response would tell a supervisor twice. Optional rather than
 * required because the act itself is legitimate to repeat: a second ask an hour
 * after the first is not a double-click, and refusing it would make the button
 * lie in exactly the situation it exists for.
 *
 * ## What is not here
 *
 * `GET /escalation-alerts` and its acknowledge, which belong to the recipient
 * rather than to the ticket and live on `EscalationAlertsController`.
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
    private readonly ticketEvents: TicketEventQueryService,
    private readonly idempotency: IdempotencyService,
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
  @RequirePermission('ticket:handoff')
  @HttpCode(HttpStatus.OK)
  assign(
    @Param('id', ticketIdPipe()) id: string,
    @Body(new ZodValidationPipe(TicketAssignInputSchema)) input: TicketAssignInput,
  ): Promise<TicketResponse> {
    return this.commands.assign(id, input).catch(translateTicketFailure);
  }

  /**
   * `POST /api/v1/tickets/{id}/escalate` — ask a supervisor to look (TAR-32,
   * 0011 decision 3).
   *
   * 200 rather than 201: the caller addresses the escalation by ticket and never
   * by its own URL, so there is no resource location to hand back. The body is
   * the audit entry and who was told — deliberately not a `TicketResponse`,
   * because nothing on the ticket moved.
   *
   * `Idempotency-Key` is **optional** and validated only when present: a client
   * that sends one gets replay protection, one that does not is making a
   * legitimate second ask. A malformed key is refused rather than ignored —
   * accepting it would silently drop the protection the caller asked for.
   */
  @Post(':id/escalate')
  @RequirePermission('ticket:escalate')
  @HttpCode(HttpStatus.OK)
  async escalate(
    @Param('id', ticketIdPipe()) id: string,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(TicketEscalateInputSchema)) input: TicketEscalateInput,
  ): Promise<TicketEscalationResponse> {
    const key = optionalIdempotencyKey(idempotencyKey);

    if (key === null) {
      return this.commands.escalate(id, input).catch(translateTicketFailure);
    }

    const outcome = await this.idempotency
      .execute<TicketEscalationResponse>(
        {
          key,
          operation: 'ticket.escalate',
          target: id,
          payload: input,
          statusCode: HttpStatus.OK,
        },
        async () => await this.commands.escalate(id, input),
      )
      .catch(translateTicketFailure);

    return outcome.body;
  }

  /**
   * `GET /api/v1/tickets/{id}/events` — the append-only history this controller
   * has had reserved since TAR-25, and the read that makes reassignment and
   * escalation visible (TAR-32, 0011 decision 4).
   *
   * `ticket:read`, and the ticket goes through `TicketQueryService.require`
   * first, so the log inherits the ticket's visibility rule exactly: one the
   * caller may not open is `not_found` here too, rather than a side channel onto
   * it.
   */
  @Get(':id/events')
  @RequirePermission('ticket:read')
  listEvents(
    @Param('id', ticketIdPipe()) id: string,
    @Query(new ZodValidationPipe(TicketEventListQuerySchema)) query: TicketEventListQuery,
  ): Promise<CursorPage<TicketEvent>> {
    return this.ticketEvents.list(id, query).catch(translateTicketFailure);
  }
}

/**
 * The header when it is there, `null` when it is not — and a refusal when it is
 * there but is not a client-generated UUID.
 *
 * Shaped rather than merely present, for `MessageSendService`'s reason: a key
 * that is not globally unique is a key that collides with another agent's, and
 * `(tenant_id, key)` would then replay somebody else's response.
 */
function optionalIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const parsed = IdSchema.safeParse(value);

  if (!parsed.success) {
    throw new ApiException(
      'validation_failed',
      'The Idempotency-Key header must carry a client-generated UUID.',
      [{ path: 'Idempotency-Key', message: 'Must be a UUID.' }],
    );
  }

  return parsed.data;
}

function ticketIdPipe(): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      new ApiException('validation_failed', 'The ticket id must be a UUID.', [
        { path: 'id', message: 'Must be a UUID.' },
      ]),
  });
}
