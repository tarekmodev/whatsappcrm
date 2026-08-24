import 'server-only';

import { cookies } from 'next/headers';
import { webEnv } from '@/lib/config/env';
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
 *
 * ## Why the flag is checked *here* rather than at the call sites
 *
 * `enableLocaleSwitch` gates the toggle's existence, and gating only that leaves
 * a trap: the cookie is `httpOnly` with a year's `maxAge`, so a reader who
 * switched to Arabic while the flag was on keeps a mirrored console — and the
 * `lang="ar"` mispronunciation the flag exists to prevent — after it goes off,
 * with no control on the page to undo it and no way for script to clear the
 * cookie. Turning the flag off has to mean the stored value stops being read at
 * all, and one check in the single place that reads it is what makes that true
 * for every caller rather than for the ones somebody remembered.
 */
export async function readLocale(): Promise<Locale> {
  if (!webEnv.enableLocaleSwitch) {
    return DEFAULT_LOCALE;
  }

  const cookieStore = await cookies();

  return parseLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value) ?? DEFAULT_LOCALE;
}
