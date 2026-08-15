import { Inject, Injectable } from '@nestjs/common';
import type { SlaAlertResponse, TicketResponse } from '@whatsappcrm/contracts';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { SLA_ALERT_PROJECTION, SLA_BREACH_ONLY, toSlaAlertResponse } from '../sla/sla-alert.mapper';
import { TICKET_PROJECTION, toTicketResponse } from '../tickets/ticket.mapper';

/**
 * Turning a breach into the two resources a socket publishes (TAR-26).
 *
 * `ConversationResourceService`'s reasoning, applied to the pair
 * `sla.breached` carries. The domain event says which ticket breached and which
 * alert rows were inserted; the wire events carry whole resources, per 0002's
 * realtime rule, so a supervisor's console renders the alert and moves the
 * ticket's queue badge without a refetch.
 *
 * Both projections and both mappers are imported rather than restated, so a
 * relayed payload and the same resource read over HTTP are identical. Those
 * imports cross a layer — this is an L1 platform module, `sla` and `tickets` are
 * L3/L4 domain ones — and are the same category of sharing
 * `MessageResourceService` documents at length: pure functions and projection
 * constants, no provider, no injection, no module edge.
 *
 * ## Isolation
 *
 * `TenantPrisma` under the scope the relay opened from the event's own tenant
 * id, so an id that somehow named another tenant's row resolves to nothing
 * rather than to a payload. There is no principal in that scope and no
 * visibility check here on purpose: *who* may see these is decided by the rooms
 * the relay addresses — the alert's own recipient for one, the ticket's current
 * assignment for the other.
 */
/**
 * One alert and the room it is addressed to.
 *
 * `recipientUserId` is read here and **not** published on `SlaAlertResponse`,
 * which is deliberate: over HTTP the list is already narrowed to the calling
 * principal, so the field would restate the caller's own id on every row. The
 * relay is the one consumer that needs it, because it is addressing somebody
 * else's room — so it selects the column rather than the contract carrying it
 * for everyone.
 */
export interface AlertDelivery {
  readonly alert: SlaAlertResponse;
  readonly recipientUserId: string;
}

export interface RelayableBreach {
  readonly ticket: TicketResponse;
  /** The inserted alerts this relay may publish, one per recipient. */
  readonly deliveries: readonly AlertDelivery[];
}

@Injectable()
export class SlaBreachResourceService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  /**
   * The ticket and its fresh alerts, or `null` when the ticket is gone.
   *
   * `null` is a race with a legitimate outcome rather than an error to shout
   * about — a tenant deleted between the commit that emitted the event and this
   * read — and the honest response to it is to relay nothing.
   *
   * Alerts that no longer resolve are simply absent from the result rather than
   * failing the whole relay: each one is an independent emit to an independent
   * recipient, and one missing row is no reason for the others to go unsent.
   */
  async findForRelay(
    ticketId: string,
    alertIds: readonly string[],
  ): Promise<RelayableBreach | null> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: TICKET_PROJECTION,
    });

    if (ticket === null) {
      return null;
    }

    const alerts = await this.prisma.notification.findMany({
      where: { ...SLA_BREACH_ONLY, id: { in: [...alertIds] } },
      select: { ...SLA_ALERT_PROJECTION, recipientUserId: true },
    });

    return {
      ticket: toTicketResponse(ticket),
      deliveries: alerts.map((alert) => ({
        alert: toSlaAlertResponse(alert),
        recipientUserId: alert.recipientUserId,
      })),
    };
  }
}
