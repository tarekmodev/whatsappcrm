import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  directionOf,
  LOCALE_ENDONYMS,
  LOCALES,
  nextLocale,
  parseLocale,
  type Locale,
} from './locale';

describe('parseLocale', () => {
  it.each(LOCALES)('accepts %s', (locale) => {
    expect(parseLocale(locale)).toBe(locale);
  });

  /*
   * The cookie is the untrusted input here: it reaches `<html lang>` and `dir`,
   * so anything unrecognised has to fall out rather than be echoed into the
   * document.
   */
  it.each(['', 'EN', 'en-GB', 'fr', 'ar-SA', '<script>', undefined])(
    'rejects %s',
    (value: string | undefined) => {
      expect(parseLocale(value)).toBeNull();
    },
  );
});

describe('directionOf', () => {
  it('reads English left to right', () => {
    expect(directionOf('en')).toBe('ltr');
  });

  it('reads Arabic right to left', () => {
    expect(directionOf('ar')).toBe('rtl');
  });

  it.each(LOCALES)('gives %s a direction at all', (locale) => {
    expect(['ltr', 'rtl']).toContain(directionOf(locale));
  });
});

describe('nextLocale', () => {
  it('swaps the two shipped locales', () => {
    expect(nextLocale('en')).toBe('ar');
    expect(nextLocale('ar')).toBe('en');
  });

  /*
   * The property that keeps a third locale from stranding a reader: pressing the
   * toggle `LOCALES.length` times has to come back to where it started, so every
   * locale is reachable from every other with the one control.
   */
  it.each(LOCALES)('cycles back to %s within one lap', (locale) => {
    let current: Locale = locale;

    for (let step = 0; step < LOCALES.length; step += 1) {
      current = nextLocale(current);
    }

    expect(current).toBe(locale);
  });

  it('visits every locale on that lap', () => {
    const seen = new Set<Locale>();
    let current: Locale = DEFAULT_LOCALE;

    for (let step = 0; step < LOCALES.length; step += 1) {
      seen.add(current);
      current = nextLocale(current);
    }

    expect(seen.size).toBe(LOCALES.length);
  });
});

describe('endonyms', () => {
  /*
   * The toggle labels itself with these, so a locale without one would ship a
   * button with no name — and the reader who needs that button is the one who
   * cannot read the interface around it.
   */
  it.each(LOCALES)('names %s in its own language', (locale) => {
    expect(LOCALE_ENDONYMS[locale]).toBeTruthy();
  });

  it('spells Arabic in Arabic script', () => {
    expect(LOCALE_ENDONYMS.ar).toBe('العربية');
  });
});

describe('the default', () => {
  it('is a locale the app ships', () => {
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });
});
