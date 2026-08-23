'use client';

import { useCallback, useSyncExternalStore, useTransition } from 'react';
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
 * The choice is persisted in a cookie by a server action, and the server renders
 * `lang` and `dir` on `<html>` from that cookie so a reload paints the right
 * direction on the first frame. The attributes are also flipped locally so the
 * change is instant rather than waiting for the round trip.
 *
 * Direction matters more than theme here: a flash of the wrong `dir` moves every
 * element on the screen rather than recolouring them, which is why nothing about
 * this is resolved after hydration.
 *
 * ## `<html lang>` is the state, not a copy of it
 *
 * The bar mounts this **twice** — `AppTopBar` hands the same `utilities` node to
 * `PrincipalMenu` and to `MobileMenu`, and the drawer keeps its children in the
 * DOM while closed, so that second instance never remounts. Holding the current
 * locale in `useState` gave the two copies separate state: pressing the one in
 * the account menu left the drawer's still labelled `العربية` while a press on it
 * would switch to English — the visible label naming the opposite of what the
 * control does.
 *
 * So the document attribute the click handler already writes is also what render
 * reads. `useSyncExternalStore` subscribes both instances to it through one
 * `MutationObserver`, so they cannot disagree, and the server snapshot is the
 * prop — which is the same value the server just wrote onto `<html>`, so there is
 * nothing for hydration to correct.
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
  const [isPending, startTransition] = useTransition();
  const locale = useDocumentLocale(initialLocale);
  const next = nextLocale(locale);

  return (
    <Button
      variant="ghost"
      size="sm"
      isPending={isPending}
      aria-label={content.language.switchTo(LOCALE_ENDONYMS[next])}
      onClick={() => {
        document.documentElement.lang = next;
        // `dir` on the element rather than the attribute helper: it is the same
        // write, and it keeps the two halves of the flip next to each other.
        document.documentElement.dir = directionOf(next);

        startTransition(async () => {
          await setLocaleAction(next);
        });
      }}
    >
      <Icon name="globe" size="sm" />
      <span lang={next}>{LOCALE_ENDONYMS[next]}</span>
    </Button>
  );
}

/**
 * The locale currently on `<html lang>`, re-read whenever anything changes it.
 *
 * An external store rather than component state because the document is shared
 * and this component is not a singleton — see the note above. The observer is
 * per-subscriber and disconnects on unmount; there is one `<html>` and at most a
 * couple of toggles, so nothing here needs pooling.
 */
function useDocumentLocale(fallback: Locale): Locale {
  const subscribe = useCallback((onChange: () => void) => {
    const observer = new MutationObserver(onChange);

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['lang'],
    });

    return () => {
      observer.disconnect();
    };
  }, []);

  const getSnapshot = useCallback(
    () => parseLocale(document.documentElement.lang) ?? fallback,
    [fallback],
  );

  // The server has just written this same value onto `<html lang>`, so the first
  // client read matches it and hydration has nothing to correct.
  const getServerSnapshot = useCallback(() => fallback, [fallback]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
