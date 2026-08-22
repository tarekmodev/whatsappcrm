'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Keeps a scrolling thread pinned to its newest entry, and counts what arrived
 * while the reader was not looking. Usage:
 *
 * ```tsx
 * const { scrollerRef, missedCount, jumpToLatest } = useStickToBottom(newestId, messages.length);
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
 * `missedCount` is what makes rule 2 visible instead of silent (TAR-518): an
 * agent reading back through a thread while the customer keeps typing had no way
 * to know anything had arrived. It counts entries added while unpinned, and
 * clears the moment the reader is back at the bottom — by scrolling there
 * themselves, or through `jumpToLatest`.
 *
 * Instant throughout rather than smooth: a scroll animation on arrival is motion
 * nobody asked for, and `behavior: 'smooth'` is the one piece of motion in this
 * app the token layer cannot flatten — it is a JavaScript argument, not a
 * duration, so honouring `prefers-reduced-motion` would mean a media query in
 * here contradicting the rule that motion is a token concern.
 */

export interface StickToBottom {
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** Entries that arrived while the reader was scrolled up. `0` when pinned. */
  missedCount: number;
  jumpToLatest: () => void;
}

export function useStickToBottom(newestEntryId: string | null, entryCount: number): StickToBottom {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const previousCountRef = useRef(entryCount);
  const [missedCount, setMissedCount] = useState(0);

  // Records where the reader is *before* the DOM changes, so the decision below
  // is about the scroll position they left, not the one the new node created.
  useEffect(() => {
    const scroller = scrollerRef.current;

    if (scroller === null) {
      return;
    }

    const onScroll = (): void => {
      wasAtBottomRef.current = isAtBottom(scroller);

      if (wasAtBottomRef.current) {
        // They caught up on their own. The pill has nothing left to offer.
        setMissedCount(0);
      }
    };

    scroller.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      scroller.removeEventListener('scroll', onScroll);
    };
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    // Read before the early return: the count has to advance even on the render
    // where there is no scroller yet, or the next one counts the whole thread as
    // having just arrived.
    const arrived = Math.max(0, entryCount - previousCountRef.current);

    previousCountRef.current = entryCount;

    if (scroller === null) {
      return;
    }

    if (wasAtBottomRef.current) {
      scrollToBottom(scroller);
      return;
    }

    if (arrived > 0) {
      setMissedCount((current) => current + arrived);
    }
  }, [newestEntryId, entryCount]);

  const jumpToLatest = useCallback(() => {
    const scroller = scrollerRef.current;

    if (scroller === null) {
      return;
    }

    wasAtBottomRef.current = true;
    setMissedCount(0);
    scrollToBottom(scroller);
  }, []);

  return { scrollerRef, missedCount, jumpToLatest };
}

/**
 * Assigning `scrollTop` rather than calling `scrollTo`: it is the same
 * instruction for an instant jump, it is what the DOM does underneath, and it is
 * the one of the two that jsdom implements — so the behaviour this hook exists
 * for stays testable.
 */
function scrollToBottom(scroller: HTMLDivElement): void {
  scroller.scrollTop = scroller.scrollHeight;
}

/**
 * Within a line or so of the end. An exact comparison never matches: sub-pixel
 * layout and zoom leave a fractional remainder that would read as "scrolled up".
 */
const BOTTOM_TOLERANCE_PX = 24;

function isAtBottom(scroller: HTMLDivElement): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_TOLERANCE_PX;
}
