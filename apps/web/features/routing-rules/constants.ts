/**
 * Sizes the routing-rule surface shares between a list, its skeleton and its
 * reads, so none of the three can disagree.
 */

/**
 * Rule cards the skeleton draws. The seeded workspace carries four rules and a
 * real one carries a handful, so three placeholders is the honest guess — and the
 * card is the same height either way, so being one out shifts nothing.
 */
export const ROUTING_RULES_SKELETON_COUNT = 3;

/** Condition rows the rule-form skeleton draws, matching a new rule's one row. */
export const CONDITION_SKELETON_COUNT = 1;

/**
 * How many agents the rule surface resolves names against.
 *
 * A **vocabulary cap, not a page size** — nothing here paginates. Every id a rule
 * stores has to resolve back to a name, so a short read does not truncate a list,
 * it makes the card assert that an active agent was removed. That is why this is
 * its own constant rather than the People table's `AGENTS_PAGE_SIZE`: the two
 * numbers answer different questions, and borrowing one for the other is how 25
 * ended up here in the first place.
 *
 * 100 is `CursorPageQuerySchema`'s ceiling, so it is as much as one read can ask
 * for. A tenant past it still mislabels — see the note in `routing-rules.data.ts`.
 */
export const VOCABULARY_LIMIT = 100;
