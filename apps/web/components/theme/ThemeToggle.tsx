'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useContent } from '@/lib/content';
import { oppositeTheme, parseTheme, type Theme } from '@/lib/theme/theme';
import { setThemeAction } from './theme.actions';

/**
 * Switches the theme. Usage: `<ThemeToggle initialTheme={theme} />`, or
 * `<ThemeToggle initialTheme={theme} isLabelVisible />` where it stands on its
 * own rather than in a row of chrome.
 *
 * The choice is persisted in a cookie by a server action, and the server renders
 * `data-theme` on `<html>` from that cookie — so a reload paints the right theme
 * on the first frame, with no flash and no client-side correction.
 *
 * The attribute is also flipped locally so the change is instant rather than
 * waiting for the round trip. Current theme is re-read from the document at click
 * time, because the top bar renders one instance for the drawer and one for
 * itself, and the two must not disagree after a resize.
 */
export function ThemeToggle({
  initialTheme,
  isLabelVisible = false,
}: {
  initialTheme: Theme;
  /**
   * Shows the target theme's name beside the icon. For the signed-out screens,
   * where this is not one control among several in a bar and an icon alone reads
   * as a stray glyph rather than as a button (TAR-521). The visible word is a
   * substring of the accessible name, which is what SC 2.5.3 asks when the two
   * differ.
   */
  isLabelVisible?: boolean;
}) {
  const content = useContent();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [isPending, startTransition] = useTransition();
  const next = oppositeTheme(theme);

  return (
    <Button
      variant="ghost"
      size="sm"
      isPending={isPending}
      aria-label={next === 'dark' ? content.theme.toggleToDark : content.theme.toggleToLight}
      onClick={() => {
        const current = parseTheme(document.documentElement.dataset.theme) ?? theme;
        const target = oppositeTheme(current);

        setTheme(target);
        document.documentElement.dataset.theme = target;

        startTransition(async () => {
          await setThemeAction(target);
        });
      }}
    >
      <Icon name={next === 'dark' ? 'moon' : 'sun'} size="sm" />
      {isLabelVisible ? (next === 'dark' ? content.theme.dark : content.theme.light) : null}
    </Button>
  );
}
