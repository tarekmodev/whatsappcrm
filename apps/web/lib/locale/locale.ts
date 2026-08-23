/**
 * The locales the console ships, and everything derivable from one.
 *
 * Deliberately free of `server-only` and of any React import: the root layout
 * reads it on the server to put `lang` and `dir` in the first HTML response, the
 * toggle reads it in the browser to flip them without a round trip, and the
 * token layer keys its Arabic branch off the `lang` this module names. Three
 * consumers, one list.
 *
 * Adding a locale is this file plus a content module — see `lib/content.ts`.
 */

export const LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];

export type Direction = 'ltr' | 'rtl';

/** What a visitor with no stored preference gets, on every layout. */
export const DEFAULT_LOCALE: Locale = 'en';

/** Read on the server so `lang`/`dir` are correct before first paint. */
export const LOCALE_COOKIE_NAME = 'wac_locale';

/** One year, matching the theme cookie: a returning reader keeps their choice. */
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const DIRECTIONS: Record<Locale, Direction> = {
  en: 'ltr',
  ar: 'rtl',
};

/**
 * Each locale's name **in itself**, which is the one label a reader who cannot
 * read the current interface can still recognise. A language's endonym is an
 * attribute of the locale rather than copy about it, so it lives here and not in
 * a content module — a translated list of language names would mean the Arabic
 * bundle spelling "Arabic" in Arabic and the English one spelling it in English,
 * and the reader who needs the control is the one who cannot read either.
 */
export const LOCALE_ENDONYMS: Record<Locale, string> = {
  en: 'English',
  ar: 'العربية',
};

export function parseLocale(value: string | undefined): Locale | null {
  return LOCALES.find((locale) => locale === value) ?? null;
}

export function directionOf(locale: Locale): Direction {
  return DIRECTIONS[locale];
}

/**
 * The locale a single toggle press lands on. A cycle rather than a swap, so a
 * third locale needs no new control — with the two shipped today it is the swap
 * it looks like.
 */
export function nextLocale(locale: Locale): Locale {
  const index = LOCALES.indexOf(locale);

  return LOCALES[(index + 1) % LOCALES.length] ?? DEFAULT_LOCALE;
}
