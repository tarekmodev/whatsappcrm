import type { SlaAlertResponse } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';

/**
 * `notifications` (`type = 'sla_breach'`) → `SlaAlertResponse`.
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
 *
 * ## The table is `notifications` now, and this reads one type of row
 *
 * TAR-394 renamed `sla_alerts` to `notifications` and added a `type` column
 * (0009, decision 7). `slaTimerId`, `kind` and `dueAt` are the `sla_breach`
 * columns and are therefore nullable — so **every query feeding this mapper
 * filters `type: 'sla_breach'`**, which is what keeps `GET /api/v1/sla-alerts`
 * the same endpoint over a wider table. `SLA_BREACH_ONLY` is that filter, shared
 * rather than repeated, so a new caller cannot forget it.
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
} as const satisfies Prisma.NotificationSelect;

/**
 * The `where` fragment that makes a `notifications` read an SLA-alert read.
 * Every caller of `toSlaAlertResponse` spreads it.
 */
export const SLA_BREACH_ONLY = {
  type: 'sla_breach',
} as const satisfies Prisma.NotificationWhereInput;

export type SlaAlertRow = Prisma.NotificationGetPayload<{ select: typeof SLA_ALERT_PROJECTION }>;

export function toSlaAlertResponse(alert: SlaAlertRow): SlaAlertResponse {
  const { slaTimerId, kind, dueAt } = alert;

  if (slaTimerId === null || kind === null || dueAt === null) {
    // Unreachable through any query that spreads `SLA_BREACH_ONLY`:
    // `notifications_sla_breach_columns` makes these three non-null for exactly
    // that type. Stated as a throw rather than a `!` so that a caller which
    // forgets the filter fails on the row it mis-read, naming the row, instead of
    // publishing an alert with a null deadline.
    throw new Error(`notification ${alert.id} is not an sla_breach row`);
  }

  return {
    id: alert.id,
    ticketId: alert.ticketId,
    ticketNumber: alert.ticket.number,
    slaTimerId,
    kind,
    dueAt: dueAt.toISOString(),
    assignedUserId: alert.ticket.assignedUserId,
    assignedTeamId: alert.ticket.assignedTeamId,
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    createdAt: alert.createdAt.toISOString(),
  };
}
