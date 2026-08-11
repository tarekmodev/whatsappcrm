export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** Read on the server so the correct theme is in the HTML before first paint. */
export const THEME_COOKIE_NAME = 'wac_theme';

/** One year, so a returning user never sees the wrong theme flash. */
export const THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function parseTheme(value: string | undefined): Theme | null {
  return THEMES.find((theme) => theme === value) ?? null;
}

export function oppositeTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}
