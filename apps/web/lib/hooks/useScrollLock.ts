'use client';

import { useEffect } from 'react';

/**
 * Locks background scrolling while an overlay is open. Usage:
 * `useScrollLock(isOpen)`.
 *
 * A data attribute on `<body>` rather than an inline style, so the rule lives in
 * `styles/base.css` with the rest of the global layer and two overlays open at
 * once cannot each restore a stale `overflow` value on the way out.
 */

const SCROLL_LOCK_ATTRIBUTE = 'data-scroll-locked';

/** Counted, so a dialog opened from inside a drawer does not unlock on its own close. */
let lockCount = 0;

export function useScrollLock(isLocked: boolean): void {
  useEffect(() => {
    if (!isLocked) {
      return;
    }

    lockCount += 1;
    document.body.setAttribute(SCROLL_LOCK_ATTRIBUTE, 'true');

    return () => {
      lockCount -= 1;

      if (lockCount === 0) {
        document.body.removeAttribute(SCROLL_LOCK_ATTRIBUTE);
      }
    };
  }, [isLocked]);
}
