'use client';

import { useCallback, useEffect, useLayoutEffect, type RefObject } from 'react';

/**
 * Keeps a `position: fixed` panel glued to the element it belongs to, opening
 * upward out of it. Usage:
 *
 * ```tsx
 * const ref = useRef<HTMLUListElement>(null);
 * useAnchoredAbove(ref);
 * <ul ref={ref}>…</ul>
 * ```
 *
 * The panel is fixed rather than absolute so that no scrolling ancestor can clip
 * it — see `CannedResponsePicker.module.css` for why that matters — and the cost
 * of being fixed is that it no longer moves with its anchor. This is that cost,
 * paid in one place: it measures the panel's own parent and writes the geometry
 * back as custom properties, so the CSS still decides what to do with it.
 *
 * Four values, and the last is the one that earns this hook: the panel is
 * bounded by the room that actually exists above the anchor, so a list longer
 * than the gap scrolls inside itself instead of running off the top of the
 * screen.
 *
 * That room is measured to the top of `<main>`, not to the top of the viewport.
 * A panel is allowed to cover the page it belongs to; it is not allowed to cover
 * the app frame around it, and the top bar is fixed there. `<main>` is a landmark
 * rather than an app-specific box, so this stays true of any screen that grows a
 * second panel like it.
 *
 * Re-measured on scroll — capturing, because the scroll that moves the anchor is
 * an ancestor's, not the window's — and on resize. Both are passive listeners
 * and both are removed with the panel.
 */
export function useAnchoredAbove(ref: RefObject<HTMLElement | null>): void {
  const place = useCallback(() => {
    const panel = ref.current;
    const anchor = panel?.parentElement ?? null;

    if (panel === null || anchor === null) {
      return;
    }

    const box = anchor.getBoundingClientRect();
    // The frame the panel must stay inside. Falls back to the viewport, which is
    // the right answer anywhere there is no `<main>` above it.
    const ceiling = panel.closest('main')?.getBoundingClientRect().top ?? 0;
    // The gap between the panel and the field it opens out of, kept in the token
    // layer rather than here: this reads it, it does not choose it.
    const gap = Number.parseFloat(getComputedStyle(panel).getPropertyValue('--picker-gap')) || 0;

    panel.style.setProperty('--picker-inline-start', `${box.left}px`);
    panel.style.setProperty('--picker-inline-size', `${box.width}px`);
    panel.style.setProperty('--picker-block-end', `${window.innerHeight - box.top + gap}px`);
    panel.style.setProperty('--picker-max-block-size', `${Math.max(0, box.top - ceiling - gap)}px`);
  }, [ref]);

  useLayoutEffect(place, [place]);

  useEffect(() => {
    window.addEventListener('scroll', place, { passive: true, capture: true });
    window.addEventListener('resize', place, { passive: true });

    return () => {
      window.removeEventListener('scroll', place, { capture: true });
      window.removeEventListener('resize', place);
    };
  }, [place]);
}
