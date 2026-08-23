import type { AgentCapacity, UserResponse } from '@whatsappcrm/contracts';

/**
 * One agent's row in the cap-edit control: who they are, what they may hold, and
 * whether their limit is the thing in the way right now.
 *
 * Narrowed here, once, so no component defends against a capacity that may be
 * absent — the same job `FlaggedTicketRow` does for a deferred ticket's routing
 * columns.
 */
export interface AgentCapacityRow {
  user: UserResponse;
  capacity: AgentCapacity;
  /** At the cap, not above it — the boundary rotation itself skips on. */
  isAtCapacity: boolean;
}

/**
 * Computed here rather than read off the response, because the contract
 * deliberately does not publish it: it is a comparison of two fields the payload
 * already carries, and a derived boolean on the wire is one more thing to keep in
 * step with them.
 */
function isAtCapacity(capacity: AgentCapacity): boolean {
  return capacity.activeTicketCount >= capacity.effectiveMaxConcurrentTickets;
}

/**
 * Everything the cap-edit control needs to open.
 *
 * Declared here rather than beside the read that fills it, so a client component
 * can take it as a prop without importing a `server-only` module for its type.
 */
export interface AgentCapacityReport {
  /** Never empty: an absent report is `null`, not a report with no agents. */
  rows: readonly AgentCapacityRow[];
  /** The cap an agent with no override of their own inherits. */
  workspaceDefault: number;
  /** True when the workspace has more agents than one page holds. */
  hasMore: boolean;
}

/**
 * Builds the rows, dropping anyone whose capacity the API did not publish.
 *
 * **Dropping rather than guessing is the point.** `assignmentCapacity` is `null`
 * for a caller who may not read it, which means this console does not know what
 * that agent's limit is. Rendering a row anyway would mean inventing a number,
 * and the whole value of the control is that a supervisor can trust the one it
 * shows.
 *
 * **At-capacity first, then the busiest.** The supervisor opened this because a
 * ticket says everyone is full; the agents whose limit is actually in the way are
 * the answer to that, so they sort to the top rather than being hunted for in an
 * alphabetical list. Name is the final tie-break so the order is stable between
 * renders.
 */
export function toAgentCapacityRows(users: readonly UserResponse[]): AgentCapacityRow[] {
  return users
    .flatMap((user) => {
      const capacity = user.assignmentCapacity;

      return capacity === null ? [] : [{ user, capacity, isAtCapacity: isAtCapacity(capacity) }];
    })
    .sort(byUrgency);
}

function byUrgency(left: AgentCapacityRow, right: AgentCapacityRow): number {
  if (left.isAtCapacity !== right.isAtCapacity) {
    return left.isAtCapacity ? -1 : 1;
  }

  if (left.capacity.activeTicketCount !== right.capacity.activeTicketCount) {
    return right.capacity.activeTicketCount - left.capacity.activeTicketCount;
  }

  return left.user.displayName.localeCompare(right.user.displayName);
}

/** The row a given agent id names, or `null` when the list no longer holds them. */
export function findCapacityRow(
  rows: readonly AgentCapacityRow[],
  userId: string,
): AgentCapacityRow | null {
  return rows.find((row) => row.user.id === userId) ?? null;
}

/**
 * What the remedy notice above the queue can offer its reader.
 *
 * A union rather than the two booleans it is derived from, because three of the
 * four combinations are real and they are not the same absence (TAR-778):
 *
 * - `edit` — the reader may change a limit and there are limits to change.
 * - `denied` — they may not. Per 0001 the button is omitted rather than
 *   disabled, and the copy names who can act instead.
 * - `unavailable` — they may, but this console cannot read the limits right now
 *   (`GET /v1/assignment-settings` unreachable, or the workspace has no agents).
 *   Telling a supervisor to ask a supervisor would be nonsense, so the notice
 *   states the fact and offers nothing.
 *
 * The notice itself renders in all three: whether the queue is stuck on a limit
 * is worth knowing even to somebody who cannot move it.
 */
export type CapacityRemedy =
  { kind: 'edit'; report: AgentCapacityReport } | { kind: 'denied' } | { kind: 'unavailable' };

export function capacityRemedy(
  canEdit: boolean,
  report: AgentCapacityReport | null,
): CapacityRemedy {
  if (!canEdit) {
    return { kind: 'denied' };
  }

  return report === null ? { kind: 'unavailable' } : { kind: 'edit', report };
}
