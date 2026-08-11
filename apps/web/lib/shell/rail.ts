export const RAIL_STATES = ['expanded', 'collapsed'] as const;
export type RailState = (typeof RAIL_STATES)[number];

/**
 * What somebody with no stored preference gets. Expanded: the labels are how a
 * new user learns the console, and the width is only reclaimed once they ask.
 */
export const DEFAULT_RAIL_STATE: RailState = 'expanded';

/** Read on the server, so the rail is already the right width in the first HTML. */
export const RAIL_COOKIE_NAME = 'wac_rail';

/** One year, matching the theme cookie — the same kind of standing preference. */
export const RAIL_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function parseRailState(value: string | undefined): RailState | null {
  return RAIL_STATES.find((state) => state === value) ?? null;
}

export function oppositeRailState(state: RailState): RailState {
  return state === 'collapsed' ? 'expanded' : 'collapsed';
}

/**
 * The rail's navigation landmark. Named once because the collapse toggle points
 * `aria-controls` at it and the two live in different components.
 */
export const RAIL_NAV_ID = 'rail-nav';
