import type { Direction } from '@/lib/locale/locale';

/**
 * Which way reading runs at a given element, read from the element itself rather
 * than from a prop or a context.
 *
 * Resolved geometry, like `MenuButton`'s shift and the chart's readout offset:
 * the direction is set once on `<html>` and inherited, so asking the DOM is both
 * the cheapest answer and the one that stays correct if a subtree ever sets its
 * own `dir` — a customer's Arabic message quoted inside an English console, say.
 *
 * ## Why every horizontal arrow key needs it
 *
 * `ArrowRight` means "the next one" in English and "the previous one" in Arabic.
 * WAI-ARIA is explicit that a horizontal composite's arrows follow the reading
 * order, not the screen, so a widget that hard-codes `+1` for `ArrowRight` walks
 * backwards through its own visual order under `dir="rtl"`. Three widgets needed
 * this — the calendar grid, the composer's tab strip and the daily-volume chart —
 * which is what made it a module rather than a fourth copy of one line.
 */
export function readingDirection(element: Element): Direction {
  return getComputedStyle(element).direction === 'rtl' ? 'rtl' : 'ltr';
}

/**
 * The step `ArrowRight` should take at this element: `1` where reading runs left
 * to right, `-1` where it runs right to left. `ArrowLeft` is its negation.
 */
export function forwardArrowStep(element: Element): 1 | -1 {
  return readingDirection(element) === 'rtl' ? -1 : 1;
}
