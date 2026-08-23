import 'server-only';

import type { AssignmentSettingsResponse } from '@whatsappcrm/contracts';
import { getAssignmentSettings } from '@/lib/api/assignment-settings';
import { listUsers } from '@/lib/api/users';
import { ApiRequestError } from '@/lib/api/http';
import { AGENTS_PAGE_SIZE } from '@/features/people/constants';
import { toAgentCapacityRows, type AgentCapacityReport } from './capacity';

/**
 * What the cap-edit control needs: every rotation candidate's limit and current
 * load, and the workspace default the ones without an override inherit
 * (TAR-384).
 *
 * **Rotation candidates, so `role: 'agent'`.** ADR 0008 decision 1 restricts the
 * candidate pool to agents, and this cap only ever affects rotation — offering a
 * supervisor's own limit here would be offering a knob that changes nothing.
 * That is the opposite call from the assign picker beside it, which deliberately
 * offers everyone active, because a manual override is exactly what rotation is
 * not.
 *
 * `status: 'active'` for the same reason it filters the assign picker: an invited
 * or suspended account holds no tickets and takes none.
 */

/**
 * `null` when the control cannot be offered — the caller may not change a limit,
 * the API does not publish capacity yet, or the workspace has no agents to tune.
 * A control that opens onto nothing it can act on is worse than no control.
 *
 * Gated on **write**, not read: the API publishes `assignmentCapacity` to either
 * permission, but nothing in this console reads a limit without offering to
 * change it, so a read for a caller who could only look would be a request nobody
 * asked for.
 */
export async function loadAgentCapacity(canEdit: boolean): Promise<AgentCapacityReport | null> {
  if (!canEdit) {
    return null;
  }

  const [agents, settings] = await Promise.all([
    listUsers({ role: 'agent', status: 'active', limit: AGENTS_PAGE_SIZE }),
    readWorkspaceDefault(),
  ]);

  if (settings === null) {
    return null;
  }

  const rows = toAgentCapacityRows(agents.items);

  return rows.length === 0
    ? null
    : {
        rows,
        workspaceDefault: settings.defaultMaxConcurrentTickets,
        hasMore: agents.nextCursor !== null,
      };
}

/**
 * The workspace default, or `null` if this API cannot answer for it.
 *
 * The one place in this feature that turns an API failure into an absence rather
 * than an error, and it is deliberate: `GET /v1/assignment-settings` arrives with
 * TAR-756, so a console rolled forward or back across that boundary can meet an
 * API that does not serve it — and this control is an enhancement sitting on top
 * of the flagged queue, not part of it. Taking the *whole queue* into its error
 * boundary over a missing limits form would be the "one broken widget blanks the
 * section" failure this codebase rules out.
 *
 * Narrow on purpose: only a refusal the API itself returned is absorbed, and it
 * is logged with its code rather than swallowed. A programming error still
 * throws.
 */
async function readWorkspaceDefault(): Promise<AssignmentSettingsResponse | null> {
  try {
    return await getAssignmentSettings();
  } catch (error) {
    if (error instanceof ApiRequestError) {
      console.warn(
        `Assignment settings unavailable (${error.code}); the cap-edit control is hidden.`,
        error,
      );

      return null;
    }

    throw error;
  }
}
