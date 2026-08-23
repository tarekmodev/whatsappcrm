import 'server-only';

import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, parseLocale, type Locale } from '@/lib/locale/locale';

/**
 * The stored locale, resolved on the server so `lang` and `dir` are already
 * correct in the first HTML response.
 *
 * The same shape as `readTheme`, and for the same reason: a direction corrected
 * after hydration is a whole layout jumping sides on the reader — a worse flash
 * than the theme's, because it moves every element on the screen rather than
 * recolouring them.
 *
 * Its own module because three layouts need it — the root one, which puts it on
 * `<html>`, and the two group layouts, which hand it to `LocaleToggle` as the
 * initial value.
 */
export async function readLocale(): Promise<Locale> {
  const cookieStore = await cookies();

  return parseLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value) ?? DEFAULT_LOCALE;
}
