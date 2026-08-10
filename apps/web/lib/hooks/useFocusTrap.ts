'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Moves focus into a panel on open and keeps Tab inside it. Usage:
 * `useFocusTrap(panelRef, isOpen)`.
 *
 * Needed for the mobile drawer specifically. The `Modal` primitive does not use
 * this — native `<dialog>` + `showModal()` already traps focus, and two
 * competing traps is worse than one.
 *
 * Escape release is the caller's job: a trap the user cannot leave is a keyboard
 * trap, which is a WCAG failure.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function useFocusTrap(panelRef: RefObject<HTMLElement | null>, isActive: boolean): void {
  useEffect(() => {
    const panel = panelRef.current;

    if (!isActive || panel === null) {
      return;
    }

    focusableWithin(panel)[0]?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Tab' || panel === null) {
        return;
      }

      const focusable = focusableWithin(panel);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (first === undefined || last === undefined) {
        return;
      }

      // Wrap at each end rather than letting focus escape to the inert page.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [panelRef, isActive]);
}

/**
 * Deliberately layout-independent. Measuring `offsetParent` or client rects would
 * be wrong for the fixed-position drawer this trap exists for, and would make the
 * behaviour impossible to test outside a real browser. The attributes below are the
 * ones that actually take an element out of the tab order.
 */
function focusableWithin(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) =>
      !element.hasAttribute('hidden') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.closest('[inert]') === null,
  );
}
