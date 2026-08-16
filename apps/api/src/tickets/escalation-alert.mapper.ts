import type { EscalationAlertResponse } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';

/**
 * `notifications` (`type = 'escalation'`) → `EscalationAlertResponse`.
 *
 * A projection constant and a pure function, so `GET /api/v1/escalation-alerts`
 * and a relayed `ticket.escalated` publish the same alert identically — the
 * arrangement `sla-alert.mapper.ts` already keeps one type over, and the reason
 * the realtime module may import both across a layer without a module edge.
 *
 * ## The table is `notifications`, and this reads one type of row
 *
 * ADR 0011 decision 5 specified a parallel `escalation_alerts` table; TAR-468
 * shipped the type instead, because TAR-394 had already generalised
 * `sla_alerts` into `notifications` (0011 amendment 1). `ticket_event_id` is the
 * escalation type's own column and is therefore nullable, so **every query
 * feeding this mapper spreads `ESCALATION_ONLY`** — which is what keeps the
 * published surface exactly what 0011 specified over a wider table.
 *
 * ## Two fields come from the event, and that is not over-fetching
 *
 * `raisedByUserId` and `reason` are the escalation itself, and a supervisor's
 * list is unreadable without them — "ticket #412, escalated" says nothing about
 * why. One join on `(tenant_id, id)`, resolved once per page rather than a call
 * per row, exactly the trade `ticketNumber` and the ticket's assignment already
 * make through the ticket relation.
 *
 * They are read at list time rather than copied onto the notification at write
 * time because `ticket_events` is append-only: the row they come from cannot
 * change, so a copy would buy nothing and add a second place for the reason to
 * live.
 */
export const ESCALATION_ALERT_PROJECTION = {
  id: true,
  ticketId: true,
  ticketEventId: true,
  acknowledgedAt: true,
  createdAt: true,
  ticket: { select: { number: true, assignedUserId: true, assignedTeamId: true } },
  ticketEvent: { select: { actorUserId: true, data: true } },
} as const satisfies Prisma.NotificationSelect;

/**
 * The `where` fragment that makes a `notifications` read an escalation read.
 * Every caller of `toEscalationAlertResponse` spreads it.
 */
export const ESCALATION_ONLY = {
  type: 'escalation',
} as const satisfies Prisma.NotificationWhereInput;

export type EscalationAlertRow = Prisma.NotificationGetPayload<{
  select: typeof ESCALATION_ALERT_PROJECTION;
}>;

export function toEscalationAlertResponse(alert: EscalationAlertRow): EscalationAlertResponse {
  const { ticketEventId, ticketEvent } = alert;
  const reason = reasonOf(ticketEvent?.data ?? null);

  if (ticketEventId === null || ticketEvent === null || ticketEvent.actorUserId === null) {
    // Unreachable through any query that spreads `ESCALATION_ONLY`:
    // `notifications_escalation_columns` makes `ticket_event_id` non-null for
    // exactly that type, the composite foreign key makes the event exist, and
    // `TicketCommandService.escalate` is the only writer — it is not reachable
    // without a principal, so the actor is never the system's null.
    throw new Error(`notification ${alert.id} is not an escalation row`);
  }

  if (reason === null) {
    // Same category, stated separately because it fails for a different reason:
    // `reason` is unconditionally required on the escalate route, so an event
    // without one was written by something that is not that route.
    throw new Error(`escalated event ${ticketEventId} carries no reason`);
  }

  return {
    id: alert.id,
    ticketId: alert.ticketId,
    ticketNumber: alert.ticket.number,
    ticketEventId,
    raisedByUserId: ticketEvent.actorUserId,
    reason,
    assignedUserId: alert.ticket.assignedUserId,
    assignedTeamId: alert.ticket.assignedTeamId,
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    createdAt: alert.createdAt.toISOString(),
  };
}

/** The agent's words, out of the event's untyped JSONB payload. */
function reasonOf(data: Prisma.JsonValue | null): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }

  const reason = (data as Record<string, unknown>)['reason'];

  return typeof reason === 'string' ? reason : null;
}
