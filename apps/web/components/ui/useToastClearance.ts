'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Keeps the toast region clear of a control pinned to the bottom of the
 * viewport. Usage, on the element doing the pinning:
 *
 * ```tsx
 * const dockRef = useRef<HTMLDivElement>(null);
 * useToastClearance(dockRef);
 * <div ref={dockRef}>…</div>
 * ```
 *
 * An ordinary page needs nothing: `PageShell`'s block-end padding already keeps
 * the last thing on the page above the toast. A fill-mode route has no padding
 * to spare and pins a control exactly where the toast lands, so the offset has
 * to be measured — a composer is a banner plus a textarea plus a button row, and
 * none of those is a fixed number.
 *
 * ## The measurement is to the control's TOP, not its height
 *
 * The toast is offset from the bottom of the *viewport*, and the pinned control
 * is not always sitting on it: between 64rem and 105rem the inbox's context
 * panel is a band underneath the thread, so the composer's bottom edge is well
 * above the viewport's. Publishing the height cleared the wrong distance and the
 * toast landed on the composer anyway. `innerHeight - top` is the distance that
 * actually matters, and it reduces to the height whenever the control is flush
 * with the bottom.
 *
 * Published on the document element rather than on a wrapper, because the toast
 * region is `position: fixed` outside this subtree and a custom property only
 * cascades down. It is removed on unmount, so a route without a pinned control
 * is back to the `0` default declared in `semantic.css`.
 */
const TOAST_OFFSET_PROPERTY = '--offset-toast-block-end';

export function useToastClearance(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;

    if (element === null) {
      return;
    }

    const root = document.documentElement;
    const publish = (): void => {
      const clearance = Math.max(0, window.innerHeight - element.getBoundingClientRect().top);

      root.style.setProperty(TOAST_OFFSET_PROPERTY, `${clearance}px`);
    };

    // Once now, so a toast fired in the same tick as the mount is already clear,
    // and again whenever the control changes size — the service window closing
    // and swapping the banner, a long file name wrapping onto a second line.
    publish();

    const observer = new ResizeObserver(publish);

    observer.observe(element);
    // The control can move without resizing — a breakpoint that puts the context
    // band under it, the address bar retracting — and only its top edge matters.
    window.addEventListener('resize', publish);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', publish);
      root.style.removeProperty(TOAST_OFFSET_PROPERTY);
    };
  }, [ref]);
}
