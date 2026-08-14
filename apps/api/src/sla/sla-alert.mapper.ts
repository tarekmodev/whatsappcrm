import type { SlaAlertResponse } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';

/**
 * `sla_alerts` → `SlaAlertResponse`.
 *
 * A projection constant and a pure function, so `GET /api/v1/sla-alerts` and a
 * relayed `sla.breached` publish the same alert identically. The realtime module
 * imports both across a layer — an L1 platform module reaching into an L4
 * feature one — which is the same category of sharing `MessageResourceService`
 * documents at length: no provider, no injection, no module edge.
 *
 * ## Three fields come from the ticket, and that is not over-fetching
 *
 * `ticketNumber`, `assignedUserId` and `assignedTeamId` are what make a
 * supervisor's alert list readable without a second call per row — "ticket #412,
 * held by nobody" rather than two ids. One join on `(tenant_id, id)`, resolved
 * once per page.
 *
 * `dueAt` is deliberately **not** among them: it is the alert's own column,
 * copied at write time, because a later policy edit or a resume must not be able
 * to rewrite the deadline a supervisor was told they missed.
 */
export const SLA_ALERT_PROJECTION = {
  id: true,
  ticketId: true,
  slaTimerId: true,
  kind: true,
  dueAt: true,
  acknowledgedAt: true,
  createdAt: true,
  ticket: { select: { number: true, assignedUserId: true, assignedTeamId: true } },
} as const satisfies Prisma.SlaAlertSelect;

export type SlaAlertRow = Prisma.SlaAlertGetPayload<{ select: typeof SLA_ALERT_PROJECTION }>;

export function toSlaAlertResponse(alert: SlaAlertRow): SlaAlertResponse {
  return {
    id: alert.id,
    ticketId: alert.ticketId,
    ticketNumber: alert.ticket.number,
    slaTimerId: alert.slaTimerId,
    kind: alert.kind,
    dueAt: alert.dueAt.toISOString(),
    assignedUserId: alert.ticket.assignedUserId,
    assignedTeamId: alert.ticket.assignedTeamId,
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    createdAt: alert.createdAt.toISOString(),
  };
}
