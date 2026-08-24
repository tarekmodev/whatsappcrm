'use client';

import { useLayoutEffect, useState, type RefObject, type TransitionEvent } from 'react';

/**
 * Keeps a dismissed overlay mounted for the length of its exit transition.
 * Usage:
 *
 * ```tsx
 * const surfaceRef = useRef<HTMLDivElement>(null);
 * const { isMounted, surfaceProps } = useExitTransition(isOpen, surfaceRef);
 *
 * return isMounted ? <div ref={surfaceRef} className={styles.panel} {...surfaceProps} /> : null;
 * ```
 *
 * 0002 §0.2 gives every panel an exit, and an exit is the one piece of motion
 * React's own rendering makes impossible by default: a removed node cannot
 * animate, and a CSS `animation` plays on arrival only. `Modal` gets away
 * without this because a `<dialog>`'s `display` belongs to the UA and
 * `allow-discrete` can hold it; a panel's belongs to React, and a panel that
 * never unmounts would come back showing state its reader had abandoned.
 *
 * The surface keeps its own `display`, so it stays hit-testable and focusable
 * while it fades. `inert` is what takes it out of the tab order and out of the
 * accessibility tree the moment it is dismissed, so nothing in it can be
 * reached during an exit nobody can see the end of.
 */

export interface ExitTransition {
  /** True while the surface is open *and* while it is leaving. */
  isMounted: boolean;
  /** Spread onto the element that carries the transition. */
  surfaceProps: {
    'data-open': 'true' | 'false';
    inert?: boolean;
    onTransitionEnd: (event: TransitionEvent<HTMLElement>) => void;
  };
}

export function useExitTransition(
  isOpen: boolean,
  surfaceRef: RefObject<HTMLElement | null>,
): ExitTransition {
  const [isLeaving, setIsLeaving] = useState(false);
  /*
   * The previous `isOpen` held as state rather than in a ref, so the derivation
   * below stays pure and survives a double render. It has to happen *during*
   * this render: an effect would leave one commit in which the surface is
   * neither open nor leaving, and React would take it out of the tree before the
   * exit had a frame to start in.
   */
  const [wasOpen, setWasOpen] = useState(isOpen);

  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    setIsLeaving(!isOpen);
  }

  /*
   * The other end of the exit. `transitionend` is the ordinary one; this is for
   * every case where it is never coming — a browser with no `@starting-style`,
   * a test environment with no style engine at all, an ancestor that was hidden
   * in the same commit. Without it a surface would wait for an event that does
   * not exist and stay in the tree for good.
   */
  useLayoutEffect(() => {
    if (isOpen || !isLeaving) {
      return;
    }

    const surface = surfaceRef.current;

    if (surface === null) {
      setIsLeaving(false);
      return;
    }

    // `getAnimations` flushes pending style, so the exit transition it is being
    // asked about has been created by the time it answers.
    const running = typeof surface.getAnimations === 'function' ? surface.getAnimations() : [];

    if (running.length === 0) {
      setIsLeaving(false);
    }
  }, [isOpen, isLeaving, surfaceRef]);

  return {
    isMounted: isOpen || isLeaving,
    surfaceProps: {
      'data-open': isOpen ? 'true' : 'false',
      inert: isOpen ? undefined : true,
      onTransitionEnd: (event) => {
        // Only the surface's own transition ends the exit; one belonging to
        // something inside it says nothing about whether this has finished.
        if (!isOpen && event.target === event.currentTarget) {
          setIsLeaving(false);
        }
      },
    },
  };
}
