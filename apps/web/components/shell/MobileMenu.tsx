'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { useContent } from '@/lib/content';
import { useScrollLock } from '@/lib/hooks/useScrollLock';
import { useFocusTrap } from '@/lib/hooks/useFocusTrap';
import { NavLinkList } from './NavLinkList';
import type { NavItem } from './navigation';
import styles from './MobileMenu.module.css';

/**
 * The small-screen navigation drawer. Usage:
 * `<MobileMenu items={items}>{extraControls}</MobileMenu>`.
 *
 * Driven by the same `NavItem[]` as the desktop header — there is no second copy
 * of the nav markup, which is what keeps the two from drifting.
 *
 * Behaviour it owns: `aria-expanded`/`aria-controls` on the trigger, focus moved
 * into the panel on open and restored to the trigger on close, a focus trap while
 * open, Escape to close, background scroll lock, close on backdrop click, and
 * close on route change.
 *
 * The trigger is part of the app shell and is therefore never lazy loaded.
 */
export function MobileMenu({
  items,
  children,
}: {
  items: readonly NavItem[];
  /** Controls that belong in the drawer below the links (theme, role stub). */
  children?: ReactNode;
}) {
  const content = useContent();
  const [isOpen, setIsOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useScrollLock(isOpen);
  useFocusTrap(panelRef, isOpen);

  // Restore focus to the trigger on close, so keyboard users are not dropped at
  // the top of the document.
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (wasOpenRef.current && !isOpen) {
      triggerRef.current?.focus();
    }

    wasOpenRef.current = isOpen;
  }, [isOpen]);

  // Navigating with the drawer open must dismiss it.
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

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  return (
    <div className={styles.wrapper}>
      <Button
        ref={triggerRef}
        variant="ghost"
        className={styles.trigger}
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => {
          setIsOpen((current) => !current);
        }}
      >
        <span aria-hidden="true" className={styles.triggerIcon}>
          {isOpen ? '✕' : '☰'}
        </span>
        {isOpen ? content.nav.closeMenu : content.nav.openMenu}
      </Button>

      {/* Rendered but inert when closed, so the panel can transition rather than
          popping in, and so the trigger's `aria-controls` target always exists. */}
      <div
        className={styles.scrim}
        data-open={isOpen ? 'true' : 'false'}
        aria-hidden="true"
        onClick={() => {
          setIsOpen(false);
        }}
      />
      <div
        id={panelId}
        ref={panelRef}
        className={styles.panel}
        data-open={isOpen ? 'true' : 'false'}
        // `inert` removes the closed panel from the tab order and from the
        // accessibility tree without `display: none`, which would kill the
        // transition.
        inert={!isOpen}
      >
        <nav aria-label={content.nav.primaryLabel} className={styles.nav}>
          <p className={styles.heading}>{content.nav.menuHeading}</p>
          <NavLinkList items={items} orientation="vertical" />
          {items.map((item) =>
            item.children === undefined || item.children.length === 0 ? null : (
              <div key={item.id} className={styles.subgroup}>
                <p className={styles.subheading}>{item.label}</p>
                <NavLinkList items={item.children} orientation="vertical" />
              </div>
            ),
          )}
        </nav>
        {children === undefined ? null : <div className={styles.extras}>{children}</div>}
      </div>
    </div>
  );
}
