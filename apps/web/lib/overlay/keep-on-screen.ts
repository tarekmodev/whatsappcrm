/**
 * Keeping a floating surface inside the viewport. Usage:
 * `surface.style.setProperty('--overlay-shift', `${String(inlineShift(surface))}px`)`.
 *
 * CSS alone cannot express "flip if it would not fit" portably yet, so the two
 * overlays that hang off a control — `MenuButton`'s panel and `Tooltip`'s tip —
 * measure themselves after they appear and nudge back inside. This module is
 * that measurement, written once: 0002 §1.5 asks the tooltip to reuse the menu's
 * rather than grow a second one that rounds differently.
 */

/** How much of the viewport edge a floating surface keeps clear of. */
export const VIEWPORT_MARGIN_PX = 8;

/**
 * How far along the inline axis a surface must move to sit inside the viewport,
 * in physical pixels. Zero when it already fits.
 *
 * A physical offset rather than a logical one on purpose: it is computed from
 * the surface's own geometry, so it is already correct under `dir="rtl"` — there
 * is no side to mirror.
 *
 * The caller resets its own offset to zero before measuring, because the offset
 * is part of the geometry being read.
 */
export function inlineShift(box: DOMRect): number {
  /*
   * `clientWidth`, not `window.innerWidth`: the latter counts a classic
   * scrollbar's width, which is space the surface cannot occupy. With a ~15px
   * scrollbar and an 8px margin, a surface overhanging the visible area by up to
   * 7px would measure as fitting. Overlay scrollbars make the two equal, so this
   * only shows up on a desktop browser that reserves the gutter.
   */
  const overflowStart = VIEWPORT_MARGIN_PX - box.left;
  const overflowEnd = box.right - (document.documentElement.clientWidth - VIEWPORT_MARGIN_PX);
  // Only one can be positive: both callers cap themselves at the viewport's
  // width, so neither can be too wide to fit once moved.
  const shift = overflowStart > 0 ? overflowStart : Math.min(0, -overflowEnd);

  return Math.round(shift);
}

/** Which side of its trigger a floating surface is on. */
export const OVERLAY_PLACEMENTS = ['blockEnd', 'blockStart'] as const;
export type OverlayPlacement = (typeof OVERLAY_PLACEMENTS)[number];

/**
 * Below the trigger unless that would run off the bottom, in which case above —
 * and back below when there is no room either way, because a surface clipped at
 * the bottom edge is at least still reachable by scrolling.
 *
 * The clearance asked for is `VIEWPORT_MARGIN_PX`, which is wider than the gap
 * any caller actually leaves between trigger and surface. Deliberately: it keeps
 * the trigger-to-surface gap a CSS value that the token layer owns rather than a
 * second copy of it in a measurement that would then have to be kept in step.
 */
export function blockPlacement(trigger: DOMRect, surfaceHeight: number): OverlayPlacement {
  const spaceBelow = document.documentElement.clientHeight - trigger.bottom;
  const spaceAbove = trigger.top;
  const needed = surfaceHeight + VIEWPORT_MARGIN_PX;

  if (spaceBelow >= needed || spaceAbove < needed) {
    return 'blockEnd';
  }

  return 'blockStart';
}
