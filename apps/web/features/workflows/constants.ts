/**
 * Sizes the workflow surface shares between a list, its skeleton and its reads,
 * so none of the three can disagree.
 */

/**
 * Workflow cards the list skeleton draws. The seeded workspace carries three and
 * a real tenant carries a handful; the card is the same height either way, so
 * being one out shifts nothing.
 */
export const WORKFLOWS_SKELETON_COUNT = 3;

/**
 * Node placeholders the canvas skeleton draws: a trigger, a condition and an
 * action — the smallest complete workflow, and the shape of most of them.
 *
 * Being one out costs nothing here, unlike a list skeleton: the canvas box has a
 * `60dvh` floor either way, so the placeholders sit *inside* a box whose height
 * does not depend on how many there are.
 */
export const CANVAS_SKELETON_NODE_COUNT = 3;

/** Run rows the run panel's skeleton draws, matching `WORKFLOW_RUNS_PAGE_SIZE`. */
export const WORKFLOW_RUNS_SKELETON_COUNT = 5;

/**
 * How many runs the "what did this workflow do" panel asks for.
 *
 * A real page size, unlike the vocabulary caps below: `workflow_runs` grows with
 * ticket volume, so this list genuinely is the first page of an unbounded set
 * (ADR 0009 — REST surface). The panel says so rather than implying it is all of
 * them.
 */
export const WORKFLOW_RUNS_PAGE_SIZE = 5;

/**
 * How many agents the workflow surface resolves names against.
 *
 * A **vocabulary cap, not a page size** — nothing here paginates. Every id a
 * workflow stores has to resolve back to a name for the picker; the *card's*
 * names come from `WorkflowResponse.references`, which the API resolves live, so
 * a short read here cannot make a card claim an active agent was removed the way
 * it can on the routing-rule surface. What it can do is leave an agent out of the
 * reassign picker, which is why it is as large as one read may ask for.
 *
 * 100 is `CursorPageQuerySchema`'s ceiling. `features/routing-rules/constants.ts`
 * states the same bound separately, because a feature may not import from another.
 */
export const WORKFLOW_VOCABULARY_LIMIT = 100;
