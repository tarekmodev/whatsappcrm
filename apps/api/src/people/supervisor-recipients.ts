/**
 * Who is told that something happened on a ticket they supervise (0006,
 * decision 4).
 *
 * A pure function over rows the caller has already read, so the rule is testable
 * without a database and lives in exactly one place — which is what makes 0006's
 * "reconsider when a tenant runs more than a handful of supervisors" a local
 * change rather than a hunt.
 *
 * ## Why it lives in `people/` rather than in `SlaModule`
 *
 * It shipped in `sla/sla-recipients.ts` with one caller. TAR-27's `notify`
 * action with `audience: 'supervisors'` is the second, and it is in
 * `WorkflowsModule` — a *sibling* L4 module, which may not import `SlaModule`
 * and must not carry a second copy of the rule (0009, delta 4). A pure function
 * two L4 modules depend on belongs below both of them, beside the role and team
 * model it is about. Nothing was changed in the move but this paragraph.
 *
 * ## Why it is derived rather than configured
 *
 * TAR-22's model has roles and teams and **no manager link**: nothing says which
 * supervisor a given agent reports to. Adding one is a migration plus a
 * management UI plus a "no manager set" empty state every other feature then has
 * to handle — and one named manager is a single point of failure, so on holiday
 * the alert goes nowhere. So the recipients are derived:
 *
 *   1. **Candidates** are the tenant's active supervisors and admins — the same
 *      population as "holds `ticket:read_all`", per 0004's matrix. They can
 *      already read the ticket, so telling them about it exposes nothing new.
 *   2. **Narrowed** to those who share a team with whoever holds the ticket.
 *   3. **Falling back** to every candidate when that yields nobody: the agent is
 *      in no team, no supervisor shares one, or the ticket is unassigned. A
 *      broad alert is worse than a narrow one; an alert delivered to nobody is
 *      worse than both.
 *
 * The assigned agent is **not** excluded when they are themselves a supervisor.
 * Someone working their own queue wants to know their own ticket breached, and
 * the special case would buy nothing but a branch.
 *
 * An empty result is a legitimate outcome — a tenant with no active supervisor
 * or admin at all. The caller writes no alert rows and logs a warning naming the
 * ticket; the ticket still shows overdue in the queue.
 */

export interface AlertCandidate {
  readonly id: string;
  /** Every team this candidate belongs to. */
  readonly teamIds: readonly string[];
}

export interface TicketResponsibility {
  readonly assignedUserId: string | null;
  readonly assignedTeamId: string | null;
  /** Every team the assigned user belongs to. Empty when nobody holds the ticket. */
  readonly assignedUserTeamIds: readonly string[];
}

export function resolveAlertRecipients(
  candidates: readonly AlertCandidate[],
  responsibility: TicketResponsibility,
): string[] {
  if (candidates.length === 0) {
    return [];
  }

  const sharedTeamIds = new Set(
    responsibility.assignedUserId === null
      ? responsibility.assignedTeamId === null
        ? []
        : [responsibility.assignedTeamId]
      : responsibility.assignedUserTeamIds,
  );

  if (sharedTeamIds.size === 0) {
    return candidates.map((candidate) => candidate.id);
  }

  const narrowed = candidates.filter((candidate) =>
    candidate.teamIds.some((teamId) => sharedTeamIds.has(teamId)),
  );

  return (narrowed.length === 0 ? candidates : narrowed).map((candidate) => candidate.id);
}
