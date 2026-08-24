'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { Tooltip } from '@/components/ui/Tooltip';
import { cx } from '@/lib/cx';
import { useContent } from '@/lib/content';
import { isCurrentPath } from '@/lib/current-path';
import type { NavItem } from './navigation';
import styles from './NavLinkList.module.css';

/**
 * Renders a list of nav links with the current one marked. Usage:
 * `<NavLinkList items={items} appearance="rail" isCollapsed={false} />`, or with
 * a More/Less boundary: `<NavLinkList items={items} primaryCount={5} />`.
 *
 * Shared by the rail and the mobile drawer, so the two cannot disagree about
 * which entry is current. `appearance` changes how the entries are painted,
 * never what they are — there is one nav data source and one piece of markup
 * for it.
 *
 * The list is always a column. A row of nav links used to be the desktop
 * header; the rail replaced it, and a horizontal tab strip is `Tabs`.
 */

export const NAV_APPEARANCES = ['bar', 'rail'] as const;
/** `bar` sits on a surface; `rail` sits on the dark navigation rail. */
export type NavAppearance = (typeof NAV_APPEARANCES)[number];

export interface NavLinkListProps {
  items: readonly NavItem[];
  appearance?: NavAppearance;
  /**
   * Rail only: hides the labels and leaves the icons. The text stays in the DOM
   * rather than being dropped, so the links keep their accessible names.
   */
  isCollapsed?: boolean;
  /**
   * How many entries are shown before a More/Less disclosure. Everything past
   * it is a destination the reader asked to see, which is what keeps a rail
   * readable once the product has more than a handful of them.
   *
   * The disclosure renders only when there is something behind it — a control
   * that reveals nothing is worse than no control, and a nav short enough to
   * show whole must not grow a button saying so.
   */
  primaryCount?: number;
  onNavigate?: () => void;
}

export function NavLinkList({
  items,
  appearance = 'bar',
  isCollapsed = false,
  primaryCount,
  onNavigate,
}: NavLinkListProps) {
  const content = useContent();
  const [isExpanded, setIsExpanded] = useState(false);
  const secondaryId = useId();

  const limit = primaryCount ?? items.length;
  const primary = items.slice(0, limit);
  const secondary = items.slice(limit);
  const hasBoundary = secondary.length > 0;

  return (
    <div className={styles.group}>
      <List
        items={primary}
        appearance={appearance}
        isCollapsed={isCollapsed}
        onNavigate={onNavigate}
      />

      {hasBoundary ? (
        <>
          {/*
            Collapsed, the word is off-screen and the chevron is all there is —
            so the pointer gets the word back. `describes` rather than `echoes`:
            the button's own name is still "More", and this says which more.
          */}
          <Tooltip tip={isCollapsed ? content.nav.moreLabel : undefined}>
            {(trigger) => (
              <button
                {...trigger}
                type="button"
                className={styles.boundary}
                data-appearance={appearance}
                data-collapsed={isCollapsed ? 'true' : undefined}
                aria-expanded={isExpanded}
                aria-controls={secondaryId}
                onClick={() => {
                  setIsExpanded((current) => !current);
                }}
              >
                <Icon name="chevronDown" size="sm" className={styles.boundaryIcon} />
                <span className={styles.label}>
                  {isExpanded ? content.nav.showLess : content.nav.showMore}
                </span>
              </button>
            )}
          </Tooltip>

          {/*
            Dropped rather than hidden when collapsed: these are links, and a
            link kept in the tree behind `hidden` is one CSS mistake away from a
            tab stop nobody can see. `aria-controls` still names the wrapper,
            which is always in the DOM.
          */}
          <div id={secondaryId}>
            {isExpanded ? (
              <List
                items={secondary}
                appearance={appearance}
                isCollapsed={isCollapsed}
                onNavigate={onNavigate}
              />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function List({
  items,
  appearance,
  isCollapsed,
  onNavigate,
}: {
  items: readonly NavItem[];
  appearance: NavAppearance;
  isCollapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <ul
      className={styles.list}
      data-appearance={appearance}
      data-collapsed={isCollapsed ? 'true' : undefined}
    >
      {items.map((item) => {
        const isCurrent = isCurrentPath(pathname, item.href);

        return (
          <li key={item.id}>
            {/*
              Collapsed, the label is the only thing naming the icon and it is
              off-screen — so the pointer gets it back. `echoes`, because the
              link already *has* that name from the span: wiring the tip as a
              description too would have a screen reader read the word twice
              (0002 §1.5's "the accessible name is on the control, always").
            */}
            <Tooltip tip={isCollapsed ? item.label : undefined} relationship="echoes">
              {(trigger) => (
                <Link
                  {...trigger}
                  href={item.href}
                  className={cx(styles.link)}
                  // `aria-current` rather than a class alone, so the state is
                  // exposed to assistive technology and not only to the eye.
                  aria-current={isCurrent ? 'page' : undefined}
                  onClick={onNavigate}
                >
                  {item.icon === undefined ? null : <Icon name={item.icon} />}
                  <span className={styles.label}>{item.label}</span>
                </Link>
              )}
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
