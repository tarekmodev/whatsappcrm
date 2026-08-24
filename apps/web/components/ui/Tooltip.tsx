'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { blockPlacement, inlineShift } from '@/lib/overlay/keep-on-screen';
import { useExitTransition } from '@/lib/hooks/useExitTransition';
import styles from './Tooltip.module.css';

/**
 * The visible spelling of a control's name. Usage:
 *
 * ```tsx
 * <Tooltip tip={isCollapsed ? item.label : undefined} relationship="echoes">
 *   {(trigger) => (
 *     <Link {...trigger} href={item.href}>…</Link>
 *   )}
 * </Tooltip>
 * ```
 *
 * **A tooltip holds a phrase** — an icon-only control's name, or the full text of
 * something visibly truncated. The moment it holds a sentence, or anything a
 * reader has to select, copy or click, it is an `InfoPopover` drawn wrong: a
 * hover surface a pointer cannot travel to is a surface a pointer user cannot
 * read (0002 §1.5).
 *
 * `tip` is optional and `undefined` means no tooltip, which is the same shape as
 * the `title` attribute this replaces — a label that is only hidden at some
 * widths stays one expression rather than two branches of markup.
 *
 * ## What it is not allowed to be the only carrier of
 *
 * Touch has no hover, so **an icon-only control must never depend on a tooltip
 * for its name**. The accessible name is on the control, always. That is what
 * `relationship` is about rather than a styling choice: a tip that repeats a name
 * the control already has describes it, a tip that supplies one labels it, and
 * one that merely draws a name already in the accessibility tree is wired to
 * nothing at all — describing it there would make a screen reader say the same
 * word twice.
 *
 * ## Delay
 *
 * 500ms before the first tooltip appears, and none for the next one while the
 * group is still warm, so scanning a row of icon buttons does not stutter.
 * Keyboard focus never waits: a tooltip that only answers to a pointer is a
 * label a keyboard user never gets.
 */

export const TOOLTIP_RELATIONSHIPS = ['describes', 'labels', 'echoes'] as const;
/**
 * `describes` — the tip adds to a name the control already has.
 * `labels` — the tip *is* the name; nothing else supplies one.
 * `echoes` — the tip repeats a name already in the accessibility tree (a
 * visually-hidden label, say) and is therefore purely visual. Never two of them:
 * `aria-labelledby` and `aria-describedby` on one control is the same string
 * announced twice.
 */
export type TooltipRelationship = (typeof TOOLTIP_RELATIONSHIPS)[number];

/** Spread onto the control the tooltip belongs to. */
export interface TooltipTriggerProps {
  /**
   * Widened to `HTMLElement` on purpose: a trigger is a button, a link or an
   * anchor-shaped component, and a callback that accepts any of them is
   * assignable to every one of their `ref` types.
   */
  ref: (node: HTMLElement | null) => void;
  'aria-describedby'?: string;
  'aria-labelledby'?: string;
  onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

export interface TooltipProps {
  /** The phrase. `undefined` renders the trigger with no tooltip at all. */
  tip?: string;
  relationship?: TooltipRelationship;
  /** The control itself, given the props that make it the trigger. */
  children: (trigger: TooltipTriggerProps) => ReactElement;
}

export function Tooltip({ tip, relationship = 'describes', children }: TooltipProps) {
  const tipId = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const openTimerRef = useRef<number | null>(null);
  const [isShown, setIsShown] = useState(false);
  // Read by `hide`, which has to know whether there was a tooltip to warm the
  // group with. A ref rather than the state itself, so nothing side-effecting
  // happens inside a state updater.
  const isShownRef = useRef(false);
  // Whether the focus about to arrive was caused by a press on this control.
  // See `shouldAnswerFocus` for why `:focus-visible` alone is not enough.
  const wasPressedRef = useRef(false);
  const { isMounted, surfaceProps } = useExitTransition(isShown && tip !== undefined, tipRef);

  const cancelPendingOpen = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    cancelPendingOpen();

    if (isShownRef.current) {
      isShownRef.current = false;
      warmGroup();
    }

    setIsShown(false);
  }, [cancelPendingOpen]);

  const show = useCallback(() => {
    cancelPendingOpen();
    isShownRef.current = true;
    setIsShown(true);
  }, [cancelPendingOpen]);

  // Timers do not survive the trigger going away — a row action whose tooltip is
  // pending when the row is removed would otherwise open onto nothing.
  useEffect(() => cancelPendingOpen, [cancelPendingOpen]);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const surface = tipRef.current;

    if (trigger === null || surface === null) {
      return;
    }

    // Reset before measuring: the nudge is part of the geometry being read.
    surface.style.setProperty('--tooltip-shift', '0px');

    const anchor = trigger.getBoundingClientRect();
    const placement = blockPlacement(anchor, surface.offsetHeight);

    surface.dataset.placement = placement;
    /*
     * Physical `left`/`top` rather than logical insets, and for the same reason
     * `--menu-shift` is physical: these come from `getBoundingClientRect`, which
     * is already resolved for the writing direction. There is no side to mirror.
     */
    surface.style.setProperty(
      '--tooltip-anchor-inline',
      `${String(anchor.left + anchor.width / 2)}px`,
    );
    surface.style.setProperty(
      '--tooltip-anchor-block',
      `${String(placement === 'blockEnd' ? anchor.bottom : anchor.top)}px`,
    );
    surface.style.setProperty(
      '--tooltip-shift',
      `${String(inlineShift(surface.getBoundingClientRect()))}px`,
    );
  }, []);

  // Measured before paint, so the tip never appears in the wrong place first.
  useLayoutEffect(() => {
    if (!isMounted) {
      return;
    }

    place();
  }, [isMounted, place]);

  useEffect(() => {
    if (!isShown) {
      return;
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        hide();
      }
    }

    /*
     * A tip is positioned against a rectangle read once. Anything that moves
     * that rectangle dismisses it rather than chasing it: a label left behind by
     * the control it names is worse than no label, and re-measuring on every
     * scroll frame is work on the main thread for a surface nobody asked to keep.
     * Capture, because most scrolling in this app happens in a pane rather than
     * on the document, and a scroll event does not bubble.
     */
    window.addEventListener('scroll', hide, { capture: true, passive: true });
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', hide);

    return () => {
      window.removeEventListener('scroll', hide, { capture: true });
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', hide);
    };
  }, [isShown, hide]);

  const trigger: TooltipTriggerProps = {
    ref: (node) => {
      triggerRef.current = node;
    },
    // Only while the tip is genuinely on screen: an `aria-describedby` naming an
    // id that is not in the document is a broken relationship, and one naming
    // the `inert` node of an exit already under way is an empty description.
    'aria-describedby':
      tip !== undefined && relationship === 'describes' && isShown ? tipId : undefined,
    'aria-labelledby':
      tip !== undefined && relationship === 'labels' && isShown ? tipId : undefined,
    onPointerEnter: (event) => {
      // Touch has no hover. A tap that opened a tooltip would also be a tap that
      // activated the control under it, so the tip would flash and leave.
      wasPressedRef.current = false;

      if (tip === undefined || event.pointerType === 'touch') {
        return;
      }

      if (isGroupWarm) {
        show();
        return;
      }

      cancelPendingOpen();
      openTimerRef.current = window.setTimeout(show, TOOLTIP_OPEN_DELAY_MS);
    },
    onPointerLeave: () => {
      wasPressedRef.current = false;
      hide();
    },
    onPointerDown: () => {
      // 0002 §1.5: the trigger being pressed dismisses it. The flag is what
      // stops the focus that follows the press putting it straight back.
      wasPressedRef.current = true;
      hide();
    },
    onFocus: () => {
      const wasPressed = wasPressedRef.current;

      wasPressedRef.current = false;

      // No delay for the keyboard, and nothing at all for a press that happens
      // to focus.
      if (tip !== undefined && shouldAnswerFocus(wasPressed)) {
        show();
      }
    },
    onBlur: () => {
      wasPressedRef.current = false;
      hide();
    },
  };

  return (
    <>
      {children(trigger)}
      {isMounted && tip !== undefined
        ? createPortal(
            /*
             * Portalled to `<body>` rather than drawn beside the trigger: the
             * rail, the inbox columns and every scrolling pane in this app clip
             * their overflow, and a tip anchored inside one is a tip with its
             * end cut off. Fixed positioning against the measured trigger is
             * what buys it out of that, and is why a scroll dismisses it.
             */
            <div ref={tipRef} id={tipId} role="tooltip" className={styles.tip} {...surfaceProps}>
              {tip}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** How long a pointer rests on a trigger before the first tooltip appears. */
const TOOLTIP_OPEN_DELAY_MS = 500;
/**
 * How long the group stays warm once one has been dismissed, so moving along a
 * row of icon buttons reads as one gesture rather than as a stutter per control.
 */
const TOOLTIP_GROUP_WARM_MS = 500;

/*
 * Warmth is a property of the *group*, not of any one tooltip, so it is module
 * state rather than component state — the second control in a row has no other
 * way to know the reader has already waited out the first one's delay.
 */
let isGroupWarm = false;
let coolTimer: number | null = null;

function warmGroup(): void {
  isGroupWarm = true;

  if (coolTimer !== null) {
    window.clearTimeout(coolTimer);
  }

  coolTimer = window.setTimeout(() => {
    isGroupWarm = false;
    coolTimer = null;
  }, TOOLTIP_GROUP_WARM_MS);
}

/**
 * Whether a focus that has just landed on the trigger should spell the label out.
 *
 * 0002 §1.5 says `:focus-visible`, and this asks the question that selector is
 * *for* rather than asking the selector: focus that arrived from a press on this
 * control is a click — and a click has already dismissed the tip a moment
 * earlier — while everything else is the keyboard.
 *
 * `element.matches(':focus-visible')` would be the direct reading and is not
 * usable here. It is unevaluable in some engines and hard-coded to `false` in
 * others (jsdom answers `false` for a genuinely focused element), so a component
 * that trusted it would ship a tooltip no keyboard user ever sees and no test
 * could catch — which is the one failure mode §1.5 singles out. The press flag
 * is the same rule with a signal that exists everywhere, and it errs toward
 * showing: an extra tooltip costs a reader a glance, a missing one costs them
 * the name of the control.
 */
function shouldAnswerFocus(wasPressed: boolean): boolean {
  return !wasPressed;
}
