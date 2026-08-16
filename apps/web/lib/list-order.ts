/**
 * Moving one item past its neighbour in an ordered list of ids.
 *
 * Two surfaces reorder a bounded, whole-set list this way — routing rules
 * (ADR 0007) and workflows (ADR 0009) — and both reorder endpoints take the
 * caller's **complete** set rather than a delta, because the whole set is also
 * their optimistic concurrency. So both need the same answer to the same
 * question, and a second copy of it in the second feature would be the first
 * place the two drifted.
 *
 * `lib/` rather than either feature, because a feature may not import from
 * another feature.
 */

export const LIST_MOVE_DIRECTIONS = ['up', 'down'] as const;
export type ListMoveDirection = (typeof LIST_MOVE_DIRECTIONS)[number];

/**
 * The whole set with `id` swapped past its neighbour, or `null` when it is
 * already at that end — which is what a list disables the control on, rather
 * than sending a reorder that would change nothing.
 *
 * `null` also covers an id that is not in the set at all: a caller working from
 * an order that no longer holds must not be handed a plausible-looking list.
 */
export function movedIds(
  ids: readonly string[],
  id: string,
  direction: ListMoveDirection,
): readonly string[] | null {
  const from = ids.indexOf(id);
  const to = direction === 'up' ? from - 1 : from + 1;

  if (from === -1 || to < 0 || to >= ids.length) {
    return null;
  }

  const moved = [...ids];

  moved[from] = ids[to] as string;
  moved[to] = id;

  return moved;
}
