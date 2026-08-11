import 'server-only';

import { cookies } from 'next/headers';
import { DEFAULT_THEME, parseTheme, THEME_COOKIE_NAME, type Theme } from './theme';

/**
 * The theme for this request, from the cookie the toggle wrote. Usage:
 * `const theme = await resolveTheme();`.
 *
 * One function rather than the same two lines in three layouts — the document,
 * the signed-in shell and the signed-out shell all need it, and a default that
 * drifted between them would show one theme in the HTML and another in the
 * toggle. Server-only by construction: read on the server so the right theme is
 * in the first HTML response and there is no flash to correct after hydration.
 */
export async function resolveTheme(): Promise<Theme> {
  const cookieStore = await cookies();

  return parseTheme(cookieStore.get(THEME_COOKIE_NAME)?.value) ?? DEFAULT_THEME;
}
