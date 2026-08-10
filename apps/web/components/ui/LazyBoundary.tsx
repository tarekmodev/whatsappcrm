'use client';

import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { SectionErrorBoundary } from './SectionErrorBoundary';

/**
 * Pairs a lazily-imported widget with its skeleton and its error boundary, so a
 * lazy boundary can never be added without both. Usage:
 *
 * ```tsx
 * <LazyBoundary fallback={<AgentLoadTable.Skeleton />} deferUntilVisible>
 *   <LazyAgentLoadTable />
 * </LazyBoundary>
 * ```
 *
 * `deferUntilVisible` holds the mount until the boundary scrolls into view, which
 * is how a below-the-fold widget keeps its chunk out of the initial load. The
 * skeleton occupies the same box either way, so deferring never shifts the layout.
 */

export interface LazyBoundaryProps {
  children: ReactNode;
  /** That widget's own skeleton, sized identically to the loaded widget. */
  fallback: ReactNode;
  deferUntilVisible?: boolean;
  /** How early to start loading, so the swap lands before it is on screen. */
  rootMargin?: string;
}

export function LazyBoundary({
  children,
  fallback,
  deferUntilVisible = false,
  rootMargin = '200px',
}: LazyBoundaryProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldMount, setShouldMount] = useState(!deferUntilVisible);

  useEffect(() => {
    if (shouldMount) {
      return;
    }

    const container = containerRef.current;

    if (container === null) {
      return;
    }

    // No IntersectionObserver (very old Safari, some test environments) means
    // mounting immediately: a widget that never appears is worse than one that
    // loads early.
    if (typeof IntersectionObserver === 'undefined') {
      setShouldMount(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldMount(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [shouldMount, rootMargin]);

  return (
    <div ref={containerRef}>
      <SectionErrorBoundary>
        {shouldMount ? <Suspense fallback={fallback}>{children}</Suspense> : fallback}
      </SectionErrorBoundary>
    </div>
  );
}
