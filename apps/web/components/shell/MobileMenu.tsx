'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useContent } from '@/lib/content';
import { useScrollLock } from '@/lib/hooks/useScrollLock';
import { useFocusTrap } from '@/lib/hooks/useFocusTrap';
import { NavLinkList } from './NavLinkList';
import type { NavItem } from './navigation';
import styles from './MobileMenu.module.css';

/**
 * The small-screen navigation drawer. Usage:
 * `<MobileMenu items={items} brand={<BrandLockup …/>}>{extraControls}</MobileMenu>`.
 *
 * Driven by the same `NavItem[]` as the rail — there is no second copy of the
 * nav markup, which is what keeps the two from drifting. Below the layout
 * breakpoint the rail is removed outright and this is the navigation.
 *
 * Behaviour it owns: `aria-expanded`/`aria-controls` on the trigger, focus moved
 * into the panel on open and restored to the trigger on close, a focus trap while
 * open, Escape to close, background scroll lock, close on backdrop click, and
 * close on route change.
 *
 * The trigger is icon-only and named by `aria-label` (TAR-522). It used to carry
 * a visible caption under the hamburger, which at 390px sat across the wordmark
 * beside it and read as a layout bug — an icon-only control needs an accessible
 * name, not a caption.
 *
 * The drawer heads its navigation with the wordmark because it *is* the rail at
 * this width, and the rail's own head is the lockup. Below 30rem the bar has no
 * room for one, so this is where the workspace is named.
 *
 * The trigger is part of the app shell and is therefore never lazy loaded.
 */
export function MobileMenu({
  items,
  brand,
  children,
}: {
  items: readonly NavItem[];
  /**
   * The product lockup, rendered by the server layout so this client component
   * pulls none of the branding into its own bundle.
   */
  brand?: ReactNode;
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
        aria-label={isOpen ? content.nav.closeMenu : content.nav.openMenu}
        onClick={() => {
          setIsOpen((current) => !current);
        }}
      >
        <Icon name={isOpen ? 'close' : 'menu'} />
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
        {brand === undefined ? null : <div className={styles.brand}>{brand}</div>}

        <nav aria-label={content.nav.primaryLabel} className={styles.nav}>
          <NavLinkList items={items} />
          {items.map((item) =>
            item.children === undefined || item.children.length === 0 ? null : (
              <div key={item.id} className={styles.subgroup}>
                <p className={styles.subheading}>{item.label}</p>
                <NavLinkList items={item.children} />
              </div>
            ),
          )}
        </nav>
        {children === undefined ? null : <div className={styles.extras}>{children}</div>}
      </div>
    </div>
  );
}
