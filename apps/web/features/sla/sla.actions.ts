'use server';

import { acknowledgeSlaAlert } from '@/lib/api/sla';
import { loadDirectory } from '@/features/inbox/directory.data';
import {
  loadSlaAlerts,
  toAlertView,
  type SlaAlertView,
  type SlaAlertsData,
} from './sla-alerts.data';
import type { ActionResult } from '@/lib/actions/result';
import { runAction } from '@/lib/actions/run-action';

/**
 * The two calls the supervisor's alert panel makes.
 *
 * A *read* as a server action is unusual, and deliberate here for the same
 * reason the composer's template picker is one: the panel is lazily mounted on
 * first open, from a client component in the app shell that has no server render
 * of its own to hang the read off. It is still an action — it wants the assert,
 * the error mapping and the "failures come back as a value" rule — it simply has
 * nothing to invalidate, which is what `revalidate: null` says.
 *
 * ## Why `ticket:read` and not `sla:read`
 *
 * ADR 0006 fixes `GET /sla-alerts` at `ticket:read`, because every row names its
 * recipient and the query adds `recipient_user_id = me` on top of row-level
 * security. An agent may call it and gets an empty page. `sla:read` gates the
 * *bell* in the shell — that is UX, so a role that can never receive an alert is
 * not shown an affordance that would always be empty — but it is not, and must
 * not become, the thing that keeps one supervisor out of another's queue.
 */

export async function loadSlaAlertsAction(): Promise<ActionResult<SlaAlertsData>> {
  return runAction({
    permission: 'ticket:read',
    parser: null,
    input: undefined,
    revalidate: null,
    label: 'SLA alerts',
    perform: async () => loadSlaAlerts(),
  });
}

/**
 * Marks one alert seen.
 *
 * Idempotent by contract: a second call returns the same row with the original
 * `acknowledgedAt` rather than a 409. That is what makes the panel's optimistic
 * removal safe to retry — and the row is returned rather than a bare `ok` so the
 * caller can reconcile against what the server actually recorded instead of
 * against what it assumed.
 *
 * `revalidate` is `null` on purpose. Acknowledging changes the shell's count,
 * not the page underneath it, and re-rendering whichever route the supervisor
 * happened to be on — the inbox, a ticket, a settings screen — to update a badge
 * in the bar would be the most expensive possible way to decrement a number. The
 * panel updates its own count and the next full render re-reads it.
 */
export async function acknowledgeSlaAlertAction(
  alertId: string,
): Promise<ActionResult<SlaAlertView>> {
  return runAction({
    permission: 'ticket:read',
    parser: null,
    input: undefined,
    revalidate: null,
    label: 'SLA alert acknowledgement',
    perform: async () => {
      const [alert, directory] = await Promise.all([acknowledgeSlaAlert(alertId), loadDirectory()]);

      return toAlertView(alert, directory.userNames, directory.teamNames);
    },
  });
}
