import { Module } from '@nestjs/common';
import { TICKET_LINKER } from '@whatsappcrm/contracts';
import { TicketLinkerService } from './ticket-linker.service';
import { TicketQueueRunner } from './ticket-queue.runner';

/**
 * Helpdesk ticketing (TAR-39, module map). TAR-21 opens tickets from inbound
 * conversations — the part that exists today; TAR-25 adds the REST surface,
 * TAR-32 the event log, TAR-23/26 assignment and SLA.
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
 * Everything else comes from global modules — `TenantPrisma` from
 * `PrismaModule`, `TenantContextService` from `TenantContextModule`,
 * `EventEmitter2` from the root `EventEmitterModule`, `QueueService` from
 * `QueueModule`.
 */
@Module({
  providers: [{ provide: TICKET_LINKER, useClass: TicketLinkerService }, TicketQueueRunner],
  exports: [TICKET_LINKER],
})
export class TicketsModule {}
