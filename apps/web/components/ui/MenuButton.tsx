'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
 */

export const MENU_ALIGNMENTS = ['start', 'end'] as const;
export type MenuAlignment = (typeof MENU_ALIGNMENTS)[number];

export interface MenuButtonProps {
  /** The trigger's content. Pair an icon-only trigger with `accessibleName`. */
  label: ReactNode;
  /** Names the trigger when `label` carries no text — an icon on its own. */
  accessibleName?: string;
  children: ReactNode;
  /** Which edge the panel is aligned to. `end` for a trigger near the inline end. */
  align?: MenuAlignment;
  className?: string;
  triggerClassName?: string;
}

export function MenuButton({
  label,
  accessibleName,
  children,
  align = 'end',
  className,
  triggerClassName,
}: MenuButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const panelId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

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
        Dropped from the DOM when closed rather than hidden. A popup has no
        entry transition to protect — unlike the drawer — and leaving links in
        the tree behind `inert` is one attribute away from a set of tab stops
        nobody can see.
      */}
      {isOpen ? (
        <div
          id={panelId}
          ref={panelRef}
          className={styles.panel}
          data-align={align}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setIsOpen(false);
            }
          }}
        >
          {children}
        </div>
      ) : (
        // `aria-controls` must name an element that exists, so the closed state
        // keeps an empty one rather than pointing at nothing.
        <div id={panelId} hidden />
      )}
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]';

function firstFocusable(container: HTMLElement | null): HTMLElement | null {
  return container?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
}
