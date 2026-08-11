import { Module } from '@nestjs/common';
import { TICKET_LINKER } from '@whatsappcrm/contracts';
import { TicketLinkerService } from './ticket-linker.service';

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
 * Nothing calls it on production traffic yet: TAR-77 adds the queue processor
 * that turns TAR-20's inbound messages into calls, once both exist.
 *
 * Everything else comes from global modules — `TenantPrisma` from
 * `PrismaModule`, `TenantContextService` from `TenantContextModule`,
 * `EventEmitter2` from the root `EventEmitterModule`.
 */
@Module({
  providers: [{ provide: TICKET_LINKER, useClass: TicketLinkerService }],
  exports: [TICKET_LINKER],
})
export class TicketsModule {}
