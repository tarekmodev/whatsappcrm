import { Inject, Injectable } from '@nestjs/common';
import type { EscalationAlertResponse, TicketResponse } from '@whatsappcrm/contracts';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import {
  ESCALATION_ALERT_PROJECTION,
  ESCALATION_ONLY,
  toEscalationAlertResponse,
} from '../tickets/escalation-alert.mapper';
import { TICKET_PROJECTION, toTicketResponse } from '../tickets/ticket.mapper';

/**
 * Turning an escalation into the two resources `ticket.escalated` publishes
 * (TAR-32, ADR 0011 decision 5).
 *
 * `SlaBreachResourceService`'s reasoning, applied to the pair this event
 * carries. The domain event says which ticket was escalated and which alert rows
 * were inserted; the wire event carries whole resources, per 0002's realtime
 * rule, so a supervisor's console renders the escalation without a refetch.
 *
 * Both projections and both mappers are imported rather than restated, so a
 * relayed payload and the same resource read over HTTP are identical. Those
 * imports cross a layer — this is an L1 platform module and `tickets` is L3 —
 * and are the category of sharing `MessageResourceService` documents at length:
 * pure functions and projection constants, no provider, no injection, no module
 * edge.
 *
 * ## Isolation
 *
 * `TenantPrisma` under the scope the relay opened from the event's own tenant
 * id, so an id that somehow named another tenant's row resolves to nothing
 * rather than to a payload. There is no principal in that scope and no
 * visibility check here on purpose: *who* may see this is decided by the room
 * the relay addresses, and every row names its own recipient.
 */

/**
 * One alert and the room it is addressed to.
 *
 * `recipientUserId` is read here and **not** published on
 * `EscalationAlertResponse`: over HTTP the list is already narrowed to the
 * calling principal, so the field would restate the caller's own id on every
 * row. The relay is the one consumer that needs it, because it is addressing
 * somebody else's room.
 */
export interface EscalationDelivery {
  readonly alert: EscalationAlertResponse;
  readonly recipientUserId: string;
}

export interface RelayableEscalation {
  readonly ticket: TicketResponse;
  /** The inserted alerts this relay may publish, one per recipient. */
  readonly deliveries: readonly EscalationDelivery[];
}

@Injectable()
export class EscalationResourceService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  /**
   * The ticket and its fresh alerts, or `null` when the ticket is gone.
   *
   * `null` is a race with a legitimate outcome rather than an error to shout
   * about — a tenant deleted between the commit that emitted the event and this
   * read — and the honest response to it is to relay nothing.
   *
   * Alerts that no longer resolve are simply absent from the result rather than
   * failing the whole relay: each is an independent emit to an independent
   * recipient, and one missing row is no reason for the others to go unsent.
   */
  async findForRelay(
    ticketId: string,
    alertIds: readonly string[],
  ): Promise<RelayableEscalation | null> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: TICKET_PROJECTION,
    });

    if (ticket === null) {
      return null;
    }

    const alerts = await this.prisma.notification.findMany({
      where: { ...ESCALATION_ONLY, id: { in: [...alertIds] } },
      select: { ...ESCALATION_ALERT_PROJECTION, recipientUserId: true },
    });

    return {
      ticket: toTicketResponse(ticket),
      deliveries: alerts.map((alert) => ({
        alert: toEscalationAlertResponse(alert),
        recipientUserId: alert.recipientUserId,
      })),
    };
  }
}
