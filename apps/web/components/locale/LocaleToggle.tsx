'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useContent } from '@/lib/content';
import {
  directionOf,
  LOCALE_ENDONYMS,
  nextLocale,
  parseLocale,
  type Locale,
} from '@/lib/locale/locale';
import { setLocaleAction } from './locale.actions';

/**
 * Switches the interface language, and with it the reading direction and the
 * typeface. Usage: `<LocaleToggle initialLocale={locale} />`.
 *
 * The same three moves as `ThemeToggle`, for the same reasons: the choice is
 * persisted in a cookie by a server action, the server renders `lang` and `dir`
 * on `<html>` from that cookie so a reload paints the right direction on the
 * first frame, and the attributes are also flipped locally so the change is
 * instant rather than waiting for the round trip. Current locale is re-read from
 * the document at click time, because the top bar renders one instance for the
 * drawer and one for the account menu and the two must not disagree.
 *
 * Direction matters more than theme here: a flash of the wrong `dir` moves every
 * element on the screen rather than recolouring them, which is why nothing about
 * this is resolved after hydration.
 *
 * ## Why the label is always visible
 *
 * A globe on its own says "language" but not *which* one, and this is the one
 * control whose reader may not be able to read the interface around it. The
 * visible label is the target language's own name — `العربية`, not "Arabic" —
 * carried in its own `lang` so a screen reader pronounces it with the right
 * voice instead of spelling it out in the current one.
 */
export function LocaleToggle({ initialLocale }: { initialLocale: Locale }) {
  const content = useContent();
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [isPending, startTransition] = useTransition();
  const next = nextLocale(locale);

  return (
    <Button
      variant="ghost"
      size="sm"
      isPending={isPending}
      aria-label={content.language.switchTo(LOCALE_ENDONYMS[next])}
      onClick={() => {
        const current = parseLocale(document.documentElement.lang) ?? locale;
        const target = nextLocale(current);

        setLocale(target);
        document.documentElement.lang = target;
        // `dir` on the element rather than the attribute helper: it is the same
        // write, and it keeps the two halves of the flip next to each other.
        document.documentElement.dir = directionOf(target);

        startTransition(async () => {
          await setLocaleAction(target);
        });
      }}
    >
      <Icon name="globe" size="sm" />
      <span lang={next}>{LOCALE_ENDONYMS[next]}</span>
    </Button>
  );
}
