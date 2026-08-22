'use client';

import type { ReactNode } from 'react';
import { Badge } from './Badge';
import { Icon } from './Icon';
import { MenuButton } from './MenuButton';
import { useContent } from '@/lib/content';
import styles from './FilterMenu.module.css';

/**
 * The secondary filters of a list view, behind one trigger. Usage:
 * `<FilterMenu activeCount={2}><FilterPills … /><FilterPills … /></FilterMenu>`.
 *
 * 0001's filter-row rule (TAR-516): a screen with more than two filter groups
 * keeps its **primary scope** visible as pills and collapses the rest in here,
 * with a count of how many are on. The ticket queue's four groups were seventeen
 * pills across four labelled rows; the count plus `ActiveFilterChips` beneath the
 * bar says the same thing in one line and leaves the queue on screen.
 *
 * The popover is `MenuButton`'s, not a second one: the disclosure contract,
 * focus in and back to the trigger, Escape, click-outside and close-on-navigate
 * are all already right there and already tested.
 */

export interface FilterMenuProps {
  /**
   * How many of the collapsed groups are narrowing the list. Shown as a badge,
   * so the trigger says a list is filtered without the filters being visible.
   */
  activeCount: number;
  children: ReactNode;
}

export function FilterMenu({ activeCount, children }: FilterMenuProps) {
  const content = useContent();

  return (
    <MenuButton
      align="start"
      variant="control"
      panelClassName={styles.panel}
      label={
        <>
          <Icon name="filter" size="sm" />
          {content.common.filters}
          {activeCount > 0 ? <Badge tone="accent">{activeCount}</Badge> : null}
        </>
      }
      // The badge is a bare numeral; on its own it announces as "Filters 2".
      accessibleName={
        activeCount > 0 ? content.common.filtersWithCount(activeCount) : content.common.filters
      }
    >
      <div className={styles.groups}>{children}</div>
    </MenuButton>
  );
}
