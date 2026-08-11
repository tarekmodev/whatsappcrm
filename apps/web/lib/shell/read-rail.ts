import 'server-only';

import { cookies } from 'next/headers';
import { DEFAULT_RAIL_STATE, parseRailState, RAIL_COOKIE_NAME, type RailState } from './rail';

/**
 * The stored rail width, resolved on the server so the frame is already the
 * right size in the first HTML response.
 *
 * The same reasoning as the theme cookie: a rail that renders expanded and then
 * snaps narrow after hydration is a layout shift on every navigation, and there
 * is no client-side correction to make if the server rendered it correctly.
 */
export async function readRailState(): Promise<RailState> {
  const cookieStore = await cookies();

  return parseRailState(cookieStore.get(RAIL_COOKIE_NAME)?.value) ?? DEFAULT_RAIL_STATE;
}
