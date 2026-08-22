'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { content } from '@/content/en';
import { ErrorState } from './ErrorState';

/**
 * Wraps one independently-failing section or lazy widget, so a single broken
 * widget cannot blank the whole page. Usage:
 *
 * ```tsx
 * <SectionErrorBoundary>
 *   <LazyAssignmentChart />
 * </SectionErrorBoundary>
 * ```
 *
 * Routes get their own boundary through Next's `error.tsx`; this is the
 * finer-grained one inside a route.
 *
 * A chunk-load failure is handled separately: after a deploy, a stale client
 * asking for a removed chunk needs a reload, not a generic retry that can never
 * succeed.
 *
 * Copy is imported directly rather than through `useContent()` because a class
 * component cannot call a hook — and an error boundary that can itself throw is
 * worse than useless.
 */

interface SectionErrorBoundaryProps {
  children: ReactNode;
  /** Shown instead of the default `ErrorState`; must be sized like the content. */
  fallback?: (retry: () => void) => ReactNode;
}

interface SectionErrorBoundaryState {
  error: Error | null;
  /** Bumped on retry so the subtree remounts rather than re-rendering. */
  attempt: number;
}

export class SectionErrorBoundary extends Component<
  SectionErrorBoundaryProps,
  SectionErrorBoundaryState
> {
  override state: SectionErrorBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<SectionErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Never swallowed. TAR-41 wires the error tracker; until then the console is
    // the only sink, and dropping the component stack would make a production
    // report unactionable.
    console.error('Section boundary caught an error', error, info.componentStack);
  }

  private readonly retry = (): void => {
    this.setState((current) => ({ error: null, attempt: current.attempt + 1 }));
  };

  private readonly reload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    const { error, attempt } = this.state;

    if (error !== null) {
      if (isChunkLoadError(error)) {
        return (
          <ErrorState
            onRetry={this.reload}
            retryLabel={content.errors.reload}
            title={content.errors.staleBundleHeading}
            description={content.errors.staleBundleBody}
          />
        );
      }

      return this.props.fallback === undefined ? (
        <ErrorState onRetry={this.retry} />
      ) : (
        this.props.fallback(this.retry)
      );
    }

    return <div key={attempt}>{this.props.children}</div>;
  }
}

/**
 * A dynamic import that 404s because a deploy replaced it. The error *name* is
 * the reliable signal; the message text is not stable across browsers, so it is
 * only a secondary check.
 */
function isChunkLoadError(error: Error): boolean {
  return error.name === 'ChunkLoadError' || /Loading chunk [\w-]+ failed/.test(error.message);
}
