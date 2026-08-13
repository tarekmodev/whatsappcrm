import 'server-only';

import { cache } from 'react';
import type { SlaAlertResponse, SlaTargetKind } from '@whatsappcrm/contracts';
import { listSlaAlerts } from '@/lib/api/sla';
import { routes } from '@/lib/routes';
import { content } from '@/content/en';
import { loadDirectory } from '@/features/inbox/directory.data';
import { SLA_ALERTS_PAGE_SIZE } from '@/features/sla/constants';

/**
 * The supervisor's alert list, flattened into what the panel renders.
 *
 * ## Why a view model rather than the raw response
 *
 * The panel is a client component — it acknowledges, so it has to be — and the
 * names behind `assignedUserId` / `assignedTeamId` come from a `server-only`
 * directory read. Resolving them here means the client receives strings rather
 * than a second fetch and a second copy of the "assigned to a team I cannot
 * name" rule.
 *
 * ## Scoping
 *
 * There is nothing to filter here, and that is the point. `GET /sla-alerts` is
 * narrowed server-side to `recipient_user_id = me` on top of row-level security,
 * so a principal who is not a recipient gets an empty page from the API rather
 * than a full page this module then has to trim. A client-side narrowing would
 * be a second rule to keep in step with the first, and the wrong one to trust.
 */

export interface SlaAlertView {
  readonly id: string;
  readonly ticketId: string;
  readonly ticketNumber: number;
  readonly kind: SlaTargetKind;
  /** The deadline that was missed, ISO 8601. Rendered relative on the client. */
  readonly dueAt: string;
  /** When the sweep detected it — not when it was due. */
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
  /** Who was holding the ticket, already resolved to a name. */
  readonly holderLabel: string;
  /** Where the row links. Built here so the panel writes no route string. */
  readonly href: string;
}

export interface SlaAlertsData {
  readonly alerts: readonly SlaAlertView[];
  /**
   * True when the API had more than one page. The bell shows "20+" rather than a
   * count it would have to page the whole table to know.
   */
  readonly hasMore: boolean;
}

/**
 * Unacknowledged alerts for the calling principal.
 *
 * Request-cached: the shell renders the count and, on a full page load, the
 * panel may render beside it. It memoises per render pass only, so an alert
 * acknowledged between requests is never carried over.
 */
export const loadSlaAlerts = cache(async function loadSlaAlerts(): Promise<SlaAlertsData> {
  const [page, directory] = await Promise.all([
    listSlaAlerts({ limit: SLA_ALERTS_PAGE_SIZE, unacknowledgedOnly: true }),
    loadDirectory(),
  ]);

  return {
    alerts: page.items.map((alert) => toAlertView(alert, directory.userNames, directory.teamNames)),
    hasMore: page.nextCursor !== null,
  };
});

export function toAlertView(
  alert: SlaAlertResponse,
  userNames: ReadonlyMap<string, string>,
  teamNames: ReadonlyMap<string, string>,
): SlaAlertView {
  return {
    id: alert.id,
    ticketId: alert.ticketId,
    ticketNumber: alert.ticketNumber,
    kind: alert.kind,
    dueAt: alert.dueAt,
    createdAt: alert.createdAt,
    acknowledgedAt: alert.acknowledgedAt,
    holderLabel: holderLabelFor(alert, userNames, teamNames),
    href: routes.ticket(alert.ticketId),
  };
}

/**
 * Who was holding the ticket when it breached.
 *
 * A name this reader's one page of the directory could not resolve still reports
 * "another agent" rather than "unassigned": ADR 0006 decision 4 falls back to
 * every supervisor in the tenant when nobody shares a team with the holder, so a
 * recipient can legitimately receive an alert about somebody they cannot name —
 * and showing a held ticket as free would send them to work already being done.
 */
function holderLabelFor(
  alert: SlaAlertResponse,
  userNames: ReadonlyMap<string, string>,
  teamNames: ReadonlyMap<string, string>,
): string {
  if (alert.assignedUserId !== null) {
    return userNames.get(alert.assignedUserId) ?? content.inbox.assignedToUnresolved;
  }

  if (alert.assignedTeamId !== null) {
    const teamName = teamNames.get(alert.assignedTeamId);

    if (teamName !== undefined) {
      return content.inbox.assignedToTeam(teamName);
    }
  }

  return content.common.unassigned;
}
