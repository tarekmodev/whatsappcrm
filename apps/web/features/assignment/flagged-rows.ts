import type {
  FallbackAssignmentReason,
  TeamResponse,
  TicketResponse,
} from '@whatsappcrm/contracts';

/** The one reason a higher limit is an answer to. */
export const CAPACITY_REASON: FallbackAssignmentReason = 'all_at_capacity';

/**
 * A flagged ticket, narrowed to the shape the queue can actually render.
 *
 * `TicketResponse.routing.deferredReason` and `deferredSince` are nullable on the
 * wire — they have to be, since most tickets are not deferred — but on this
 * surface they never are: the database carries a `CHECK` tying all three together
 * (ADR 0008). Narrowing once, here, is what stops every cell in the table
 * defending against a null it will never see, or worse, asserting past it.
 */
export interface FlaggedTicketRow {
  ticket: TicketResponse;
  reason: FallbackAssignmentReason;
  /** ISO 8601, when the ticket first became stuck. */
  flaggedSince: string;
  /**
   * The team routing tried, or `null` for the whole-workspace pool.
   *
   * **Null for every ticket the API can currently produce** (TAR-537): a matched
   * rule assigns its target and stops, so only rotation-with-nobody defers, and
   * it defers without a team. Kept rather than dropped because rotating within a
   * matched team is a story the rule engine explicitly leaves for later, and this
   * is the cell that reads it.
   */
  routedToTeamName: string | null;
}

/**
 * Builds the rows, dropping any ticket whose routing columns disagree with its
 * state.
 *
 * Dropping rather than rendering a half-row is the deliberate choice: such a
 * ticket is a bug in the writer, and a queue that shows "flagged for reason
 * (unknown), waiting (unknown)" invites a supervisor to act on a row that means
 * nothing. The database constraint makes it unreachable through the API; this
 * keeps it unreachable through a mock or a future partial write too.
 */
export function toFlaggedTicketRows(
  tickets: readonly TicketResponse[],
  teams: readonly TeamResponse[],
): FlaggedTicketRow[] {
  const teamNamesById = new Map(teams.map((team) => [team.id, team.name]));

  return tickets.flatMap((ticket) => {
    const { deferredReason, deferredSince } = ticket.routing;

    if (deferredReason === null || deferredSince === null) {
      return [];
    }

    return [
      {
        ticket,
        reason: deferredReason,
        flaggedSince: deferredSince,
        routedToTeamName:
          ticket.assignedTeamId === null
            ? null
            : // A team id that no longer resolves renders as the workspace pool
              // rather than a raw uuid — the same call `AgentsTable` makes for a
              // stale membership.
              (teamNamesById.get(ticket.assignedTeamId) ?? null),
      },
    ];
  });
}

/**
 * How many rows on this page are stuck on a limit.
 *
 * The remedy notice above the table counts **rendered rows**, never the queue:
 * the page is capped at `FLAGGED_TICKETS_PAGE_SIZE` and `toFlaggedTicketRows`
 * can drop a ticket besides, so any wider claim would be one nobody checked —
 * the same discipline `flaggedQueueSummary` keeps one line above it.
 */
export function countAtCapacity(rows: readonly FlaggedTicketRow[]): number {
  return rows.filter((row) => row.reason === CAPACITY_REASON).length;
}
