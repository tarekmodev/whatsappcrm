'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Keeps a scrolling thread pinned to its newest entry. Usage:
 *
 * ```tsx
 * const scrollerRef = useStickToBottom(newestMessageId);
 * <div ref={scrollerRef}>…</div>
 * ```
 *
 * Two rules, and the second is the one that matters:
 *
 *   1. On mount, jump to the bottom. A thread opens on its newest message; the
 *      top of a two-year-old conversation is not where anybody starts reading.
 *   2. On a new entry, follow **only if the reader was already at the bottom**.
 *      A background refetch must not yank somebody out of the message they
 *      scrolled up to read — the same rule the data-fetching guidance states for
 *      not wiping a view under the user.
 *
 * `behavior: 'auto'` rather than smooth: a scroll animation on arrival is motion
 * nobody asked for, and it would need a `prefers-reduced-motion` branch to be
 * honest about it.
 */
export function useStickToBottom(newestEntryId: string | null): RefObject<HTMLDivElement | null> {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  // Records where the reader is *before* the DOM changes, so the decision below
  // is about the scroll position they left, not the one the new node created.
  useEffect(() => {
    const scroller = scrollerRef.current;

    if (scroller === null) {
      return;
    }

    const onScroll = (): void => {
      wasAtBottomRef.current = isAtBottom(scroller);
    };

    scroller.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      scroller.removeEventListener('scroll', onScroll);
    };
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;

    if (scroller === null || !wasAtBottomRef.current) {
      return;
    }

    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
  }, [newestEntryId]);

  return scrollerRef;
}

/**
 * Within a line or so of the end. An exact comparison never matches: sub-pixel
 * layout and zoom leave a fractional remainder that would read as "scrolled up".
 */
const BOTTOM_TOLERANCE_PX = 24;

function isAtBottom(scroller: HTMLDivElement): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_TOLERANCE_PX;
}
