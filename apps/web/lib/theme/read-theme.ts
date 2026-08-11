import 'server-only';

import { cookies } from 'next/headers';
import { DEFAULT_THEME, parseTheme, THEME_COOKIE_NAME, type Theme } from '@/lib/theme/theme';

/**
 * The stored theme, resolved on the server so `data-theme` is already correct in
 * the first HTML response and there is no flash to correct after hydration.
 *
 * Its own module because two layouts need it — the root one, which puts it on
 * `<html>`, and the app shell, which hands it to `ThemeToggle` as the initial
 * value. Two copies of the same three lines is how those two end up disagreeing.
 */
export async function readTheme(): Promise<Theme> {
  const cookieStore = await cookies();

  return parseTheme(cookieStore.get(THEME_COOKIE_NAME)?.value) ?? DEFAULT_THEME;
}
