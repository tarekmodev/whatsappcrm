/**
 * Page sizes, skeleton counts and intervals for the SLA surfaces (TAR-26).
 *
 * Here rather than inline so a list, the skeleton that stands in for it and the
 * query that fills it cannot disagree.
 */

/** How many alerts the supervisor's panel opens with. */
export const SLA_ALERTS_PAGE_SIZE = 20;

/**
 * Rows in the panel's skeleton. Fewer than a page: a skeleton stands in for what
 * is about to be *on screen*, not for what the request returns.
 */
export const SLA_ALERTS_SKELETON_COUNT = 3;

/**
 * How many policies the settings screen reads (TAR-390).
 *
 * One page, and a generous one: a tenant has a catch-all plus at most one row
 * per priority, so twenty-five is already several times the reachable maximum.
 * The screen still reports `nextCursor` rather than assuming that — a list that
 * silently stops is a list that lies.
 */
export const SLA_POLICIES_PAGE_SIZE = 25;

/**
 * How often a running countdown re-phrases itself, in milliseconds.
 *
 * Matched to ADR 0006's `SLA_SWEEP_INTERVAL_MS` on purpose: the sweep is what
 * decides a breach, so a console that re-phrased faster would be claiming a
 * precision the detection mechanism does not have — and one that re-phrased
 * slower could sit on "due in a minute" after the ticket had already breached.
 */
export const SLA_COUNTDOWN_REFRESH_MS = 30_000;
