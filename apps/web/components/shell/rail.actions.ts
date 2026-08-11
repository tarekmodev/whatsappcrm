'use server';

import { cookies } from 'next/headers';
import {
  RAIL_COOKIE_MAX_AGE_SECONDS,
  RAIL_COOKIE_NAME,
  RAIL_STATES,
  type RailState,
} from '@/lib/shell/rail';

/**
 * Persists whether the navigation rail is collapsed. Server-side for the same
 * reason as the theme: the next server render reads the cookie, so the frame
 * paints at the right width on the first frame.
 */
export async function setRailStateAction(state: RailState): Promise<void> {
  if (!RAIL_STATES.includes(state)) {
    // A server action is a public endpoint; its argument is untrusted.
    throw new Error('Unknown rail state.');
  }

  const cookieStore = await cookies();

  cookieStore.set(RAIL_COOKIE_NAME, state, {
    path: '/',
    maxAge: RAIL_COOKIE_MAX_AGE_SECONDS,
    sameSite: 'lax',
    // A layout preference: carries no personal data and the client never reads it.
    httpOnly: true,
  });
}
