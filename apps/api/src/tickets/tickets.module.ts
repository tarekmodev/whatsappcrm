import { Module } from '@nestjs/common';
import { TICKET_LINKER } from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { EscalationAlertService } from './escalation-alert.service';
import { EscalationAlertsController } from './escalation-alerts.controller';
import { TicketCommandService } from './ticket-command.service';
import { TicketEventQueryService } from './ticket-event-query.service';
import { TicketLinkerService } from './ticket-linker.service';
import { TicketQueryService } from './ticket-query.service';
import { TicketQueueRunner } from './ticket-queue.runner';
import { TicketsController } from './tickets.controller';

/**
 * Helpdesk ticketing (TAR-39, module map). TAR-21 opens tickets from inbound
 * conversations and TAR-25 adds the REST surface — the parts that exist today;
 * TAR-32 the event log, TAR-23/26 assignment and SLA.
 *
 * ## Two writers, and they do not meet
 *
 * `TicketCommandService` serves the agent's PATCH; `TicketLinkerService` moves a
 * `pending` ticket to `open` off the inbound-message queue. Neither imports the
 * other and there is no shared write helper. What keeps them consistent is that
 * both express their write as a compare-and-set on `status` — the rule
 * `ticket-command.service.ts` states and the one a reviewer should check.
 *
 * An **L3 domain module**: it may import platform and access modules below it,
 * never one beside or above it. Notably it does not import `ConversationsModule`
 * or `WebhooksModule`, and neither of them imports this — what crosses the line
 * is the shape in `@whatsappcrm/contracts/ticket-linking`, which both sides
 * depend on and neither owns.
 *
 * `TICKET_LINKER` is the module's whole public surface, and it is a token rather
 * than the class so a consumer names the contract instead of the implementation.
 * Since TAR-77 it is driven by real traffic: `TicketQueueRunner` consumes the
 * `ticket.ensure-for-message` jobs TAR-20's inbound writer enqueues once a
 * message has committed. The two sides still never meet in code — only over the
 * queue, and only through the contract's shape.
 *
 * ## TAR-32's escalation surface lives here, not in `SlaModule`
 *
 * An escalation is a ticket event with recipients, and `TicketCommandService`
 * is its writer — so `EscalationAlertService` and the supervisor's
 * `/escalation-alerts` routes belong to this module. The alternative would be a
 * module edge from L3 to L4, which the layering forbids in that direction.
 *
 * What *is* shared with `SlaModule` is `resolveAlertRecipients`, a pure function
 * imported from `people/supervisor-recipients.ts` with no provider, no injection
 * and no module edge. A breach and an escalation ask the same question, and two
 * answers that drift would send them to different people. It sat in `sla/` until
 * TAR-27 made `WorkflowsModule` its third caller; a rule three modules depend on
 * belongs below all of them, which is also what stops this import crossing a
 * layer.
 *
 * `IdempotencyModule` is the one import: `POST /tickets/{id}/escalate` is the
 * first non-billing route in this API that genuinely creates, and it honours an
 * optional `Idempotency-Key` so a retry after a dropped response cannot notify
 * a supervisor twice.
 *
 * Everything else comes from global modules — `TenantPrisma` from
 * `PrismaModule`, `TenantContextService` from `TenantContextModule`,
 * `EventEmitter2` from the root `EventEmitterModule`, `QueueService` from
 * `QueueModule`.
 */
@Module({
  imports: [IdempotencyModule],
  controllers: [TicketsController, EscalationAlertsController],
  providers: [
    { provide: TICKET_LINKER, useClass: TicketLinkerService },
    TicketQueueRunner,
    TicketQueryService,
    TicketEventQueryService,
    TicketCommandService,
    EscalationAlertService,
    ApiExceptionFilter,
  ],
  // `TICKET_LINKER` is the seam `ConversationsModule` reaches over a queue.
  // `TicketCommandService` is exported for exactly one consumer —
  // `WorkflowsModule` (L4), whose action executor writes ticket status, priority
  // and assignment through `applyAutomation` rather than reimplementing five
  // behaviours that live in that class (0009, decision 5). L4 importing L3 is
  // what 0002's layering rule permits; the reverse would not be.
  exports: [TICKET_LINKER, TicketCommandService],
})
export class TicketsModule {}
