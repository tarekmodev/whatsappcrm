'use server';

import { cookies } from 'next/headers';
import {
  THEME_COOKIE_MAX_AGE_SECONDS,
  THEME_COOKIE_NAME,
  THEMES,
  type Theme,
} from '@/lib/theme/theme';

/**
 * Persists the theme choice. Server-side so the cookie is set on a response the
 * server also renders from — which is what keeps the first paint flash-free.
 */
export async function setThemeAction(theme: Theme): Promise<void> {
  if (!THEMES.includes(theme)) {
    // A server action is a public endpoint; its argument is untrusted.
    throw new Error('Unknown theme.');
  }

  const cookieStore = await cookies();

  cookieStore.set(THEME_COOKIE_NAME, theme, {
    path: '/',
    maxAge: THEME_COOKIE_MAX_AGE_SECONDS,
    sameSite: 'lax',
    // Carries no personal data, and the client needs no read access to it.
    httpOnly: true,
  });
}
