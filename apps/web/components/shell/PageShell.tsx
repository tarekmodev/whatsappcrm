import type { ReactNode } from 'react';
import { Container } from '@/components/layout/Container';
import { Stack } from '@/components/layout/Stack';
import styles from './PageShell.module.css';

/**
 * The frame a route's sections sit in. Usage: `<PageShell>{sections}</PageShell>`,
 * or `<PageShell variant="fill">{workspace}</PageShell>` for a list-and-detail
 * screen.
 *
 * Exists so a page file never writes padding or a container of its own — page
 * files stay composition-only, and every route lines up at every width.
 *
 * ## The two variants
 *
 *   * **`flow`** (the default) — a document. Capped at `--size-container-xl`,
 *     with the fluid gutter and the vertical rhythm every ordinary route has,
 *     and clearance at the foot for the toast region.
 *   * **`fill`** — a workspace. Exactly the region the top bar left, with each
 *     column inside owning its own scrolling. Full-bleed: no cap, no gutter, no
 *     block padding, because the dividers between those columns are the
 *     structure and a gutter would put canvas back either side of the very
 *     screen this variant exists to remove.
 *
 * Fill mode takes ONE workspace child; anything else it renders must draw
 * nothing (the inbox's realtime socket, for instance) or position itself out of
 * flow, or it will claim a row of its own.
 *
 * `data-page-shell="fill"` is the seam `AppShell` reads to stop the frame
 * growing with its content — see `AppShell.module.css`.
 */

export const PAGE_SHELL_VARIANTS = ['flow', 'fill'] as const;
export type PageShellVariant = (typeof PAGE_SHELL_VARIANTS)[number];

export interface PageShellProps {
  children: ReactNode;
  variant?: PageShellVariant;
}

export function PageShell({ children, variant = 'flow' }: PageShellProps) {
  if (variant === 'fill') {
    return (
      <div className={styles.fill} data-page-shell="fill">
        {children}
      </div>
    );
  }

  return (
    <Container size="xl" className={styles.shell}>
      <Stack gap="5">{children}</Stack>
    </Container>
  );
}
