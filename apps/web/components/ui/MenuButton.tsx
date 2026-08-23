'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { cx } from '@/lib/cx';
import styles from './MenuButton.module.css';

/**
 * A button that opens a small panel of actions under itself. Usage:
 * `<MenuButton label={<Icon name="plus" />} accessibleName="Create">…</MenuButton>`.
 *
 * A **disclosure**, not an ARIA menu. `role="menu"` promises a single-tab-stop
 * widget driven by the arrow keys, and the things that go in here are ordinary
 * links and submit buttons — announcing them as menu items while Tab still moves
 * between them is a worse lie than not announcing them at all. What this owns is
 * the behaviour a popup needs either way: `aria-expanded`/`aria-controls`, focus
 * moved into the panel on open and restored to the trigger on close, Escape to
 * close, a click outside to close, and close on route change.
 *
 * Nothing here traps focus. A menu is not modal: tabbing past its last entry
 * should leave it, and it closes when it loses focus.
 *
 * ## Staying on screen
 *
 * `align` says which edge of the *trigger* the panel hangs from, and on a narrow
 * screen that is not enough: the top bar's controls wrap onto their own line at
 * the inline start, so a panel anchored to a trigger's end edge grows away from
 * the viewport. It is clipped rather than scrolled — overflow past the inline
 * start produces no scrollbar — so it reads as a panel that lost half its
 * contents rather than as a layout that is too wide.
 *
 * CSS alone cannot express "flip if it would not fit" portably yet, so this
 * measures the opened panel and nudges it back inside. Measured geometry rather
 * than a breakpoint, because where a trigger sits depends on the bar's wrapping,
 * which depends on how long the signed-in user's name is.
 */

export const MENU_ALIGNMENTS = ['start', 'end'] as const;
export type MenuAlignment = (typeof MENU_ALIGNMENTS)[number];

/**
 * How the trigger is painted. `bare` is a control inside a bar that already has
 * a surface — the top bar, a table row. `control` is a filter or a picker
 * standing on its own in a row of inputs, and matches `TextInput` exactly so the
 * two cannot sit side by side looking like different products (TAR-516).
 * `icon` is a mark beside a label rather than a control at all — the info
 * affordance on a metric tile (TAR-519), whose panel holds a sentence rather
 * than a list of entries and is widened to match.
 */
export const MENU_TRIGGER_VARIANTS = ['bare', 'control', 'icon'] as const;
export type MenuTriggerVariant = (typeof MENU_TRIGGER_VARIANTS)[number];

/** What the panel's contents can do to the menu around them. */
export interface MenuPanelApi {
  /** Dismisses the panel and returns focus to the trigger. */
  close: () => void;
}

export interface MenuButtonProps {
  /** The trigger's content. Pair an icon-only trigger with `accessibleName`. */
  label: ReactNode;
  /** Names the trigger when `label` carries no text — an icon on its own. */
  accessibleName?: string;
  /**
   * The panel's contents. A function receives `close`, for a panel whose own
   * controls finish the interaction — an Apply button, a preset that commits.
   * Without it every such panel would need its own copy of the focus-restoring
   * dismissal this component already owns.
   */
  children: ReactNode | ((api: MenuPanelApi) => ReactNode);
  /** Which edge the panel is aligned to. `end` for a trigger near the inline end. */
  align?: MenuAlignment;
  /**
   * `control` gives the trigger `TextInput`'s box, `bare` leaves it transparent,
   * `icon` shrinks it to a glyph. It also sizes the panel: an `icon` trigger's
   * panel holds prose, not a column of entries.
   */
  variant?: MenuTriggerVariant;
  className?: string;
  triggerClassName?: string;
  /** Widens or re-pads the panel; the popover's placement stays this component's. */
  panelClassName?: string;
}

export function MenuButton({
  label,
  accessibleName,
  children,
  align = 'end',
  variant = 'bare',
  className,
  triggerClassName,
  panelClassName,
}: MenuButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const panelId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  const closePanel = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Focus into the panel on open, back to the trigger on close — a keyboard user
  // who opens a panel and is left outside it has no way in but Tab.
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      firstFocusable(panelRef.current)?.focus();
    }

    if (!isOpen && wasOpenRef.current) {
      triggerRef.current?.focus();
    }

    wasOpenRef.current = isOpen;
  }, [isOpen]);

  // Navigating from inside the panel must dismiss it.
  const lastPathnameRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastPathnameRef.current !== null && lastPathnameRef.current !== pathname) {
      setIsOpen(false);
    }

    lastPathnameRef.current = pathname;
  }, [pathname]);

  // Measured before paint, so the panel never appears in the wrong place first.
  const keepOnScreen = useCallback(() => {
    const panel = panelRef.current;

    if (panel === null) {
      return;
    }

    // Reset before measuring: the shift is part of the geometry being read.
    panel.style.setProperty('--menu-shift', '0px');

    const box = panel.getBoundingClientRect();
    // `clientWidth`, not `window.innerWidth`: the latter counts a classic
    // scrollbar's width, which is space the panel cannot occupy. With a ~15px
    // scrollbar and an 8px margin, a panel overhanging the visible area by up to
    // 7px would measure as fitting. Overlay scrollbars make the two equal, so
    // this only shows up on a desktop browser that reserves the gutter.
    const overflowStart = VIEWPORT_MARGIN_PX - box.left;
    const overflowEnd = box.right - (document.documentElement.clientWidth - VIEWPORT_MARGIN_PX);
    // Only one can be positive: `max-inline-size` already caps the panel at the
    // viewport, so it cannot be too wide to fit once moved.
    const shift = overflowStart > 0 ? overflowStart : Math.min(0, -overflowEnd);

    panel.style.setProperty('--menu-shift', `${String(Math.round(shift))}px`);
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    keepOnScreen();

    // A rotation or a resized window moves the trigger under an open panel.
    window.addEventListener('resize', keepOnScreen);

    return () => {
      window.removeEventListener('resize', keepOnScreen);
    };
  }, [isOpen, keepOnScreen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    // `pointerdown` rather than `click`: a click on a control outside the panel
    // should close it *and* do its own job, and waiting for `click` means the
    // panel is still over the pointer when the browser resolves the target.
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;

      if (target instanceof Node && wrapperRef.current?.contains(target) === true) {
        return;
      }

      setIsOpen(false);
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [isOpen]);

  return (
    <div ref={wrapperRef} className={cx(styles.wrapper, className)}>
      <button
        ref={triggerRef}
        type="button"
        className={cx(styles.trigger, triggerClassName)}
        data-variant={variant}
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-label={accessibleName}
        onClick={() => {
          setIsOpen((current) => !current);
        }}
      >
        {label}
      </button>

      {/*
        Dropped from the DOM when closed rather than hidden. The panel does have
        an *entrance* — see `menuPanelEnter` — but an entrance plays on a node
        that has just been added, and only an *exit* would need one kept around
        to play out. It has none, by the reference's own reading: a dismissed
        menu is the reader having already decided, and leaving links in the tree
        behind `inert` to animate them away is one attribute away from a set of
        tab stops nobody can see.
      */}
      {isOpen ? (
        <div
          id={panelId}
          ref={panelRef}
          className={cx(styles.panel, panelClassName)}
          data-align={align}
          data-variant={variant}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setIsOpen(false);
            }
          }}
        >
          {typeof children === 'function' ? children({ close: closePanel }) : children}
        </div>
      ) : (
        // `aria-controls` must name an element that exists, so the closed state
        // keeps an empty one rather than pointing at nothing.
        <div id={panelId} hidden />
      )}
    </div>
  );
}

/** How much of the viewport edge the panel keeps clear of. */
const VIEWPORT_MARGIN_PX = 8;

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]';

function firstFocusable(container: HTMLElement | null): HTMLElement | null {
  return container?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
}
