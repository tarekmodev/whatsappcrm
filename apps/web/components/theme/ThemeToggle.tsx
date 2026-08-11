'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { useContent } from '@/lib/content';
import { oppositeTheme, parseTheme, type Theme } from '@/lib/theme/theme';
import { setThemeAction } from './theme.actions';

/**
 * Switches the theme. Usage: `<ThemeToggle initialTheme={theme} />`.
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
export function ThemeToggle({ initialTheme }: { initialTheme: Theme }) {
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
      <span aria-hidden="true">{next === 'dark' ? '🌙' : '☀️'}</span>
    </Button>
  );
}
