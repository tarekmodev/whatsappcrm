'use server';

import { cookies } from 'next/headers';
import {
  LOCALE_COOKIE_MAX_AGE_SECONDS,
  LOCALE_COOKIE_NAME,
  LOCALES,
  type Locale,
} from '@/lib/locale/locale';

/**
 * Persists the locale choice. Server-side so the cookie is set on a response the
 * server also renders from — which is what keeps `lang`/`dir` correct on the
 * first frame of the next navigation instead of flipping after hydration.
 */
export async function setLocaleAction(locale: Locale): Promise<void> {
  if (!LOCALES.includes(locale)) {
    // A server action is a public endpoint; its argument is untrusted.
    throw new Error('Unknown locale.');
  }

  const cookieStore = await cookies();

  cookieStore.set(LOCALE_COOKIE_NAME, locale, {
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
    sameSite: 'lax',
    // Carries no personal data, and the client needs no read access to it: the
    // toggle reads the current locale from `<html lang>`, which the server wrote.
    httpOnly: true,
  });
}
