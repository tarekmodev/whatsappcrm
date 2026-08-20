'use client';

import { useRef, type ReactNode } from 'react';
import { useToastClearance } from '@/components/ui/useToastClearance';
import styles from './ThreadComposerDock.module.css';

/**
 * The composer's place at the foot of the thread column. Usage:
 * `<ThreadComposerDock><ThreadComposerTabs … /></ThreadComposerDock>`.
 *
 * Pinned, so the reply box is reachable without scrolling however long the
 * conversation is — which is the whole point of the fixed-height workspace
 * around it.
 *
 * It also publishes its own height as the toast region's bottom offset. The
 * toast is fixed to the bottom of the viewport, and on this route that is
 * exactly where the send control is: an ordinary page keeps the two apart with
 * `PageShell`'s block-end padding, and a fill-mode route has none to spend. A
 * client component for that one reason — its children arrive as a prop, already
 * rendered on the server.
 */
export function ThreadComposerDock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useToastClearance(ref);

  return (
    <div ref={ref} className={styles.dock}>
      {children}
    </div>
  );
}
