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
