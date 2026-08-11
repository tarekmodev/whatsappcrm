'use client';

import { Icon } from '@/components/ui/Icon';
import { useContent } from '@/lib/content';
import { RAIL_NAV_ID } from '@/lib/shell/rail';
import { useRail } from './AppShell';
import styles from './RailToggle.module.css';

/**
 * Collapses and expands the navigation rail. Usage: `<RailToggle />`.
 *
 * A disclosure, so it carries `aria-expanded` and points `aria-controls` at the
 * rail's navigation landmark. Collapsing hides the labels from the eye only —
 * the links keep their names, so this changes the width and nothing else.
 *
 * Deliberately not a `<Button>`: every Button variant is coloured for a content
 * surface, and this control sits on the dark rail. Overriding the variant from
 * here would be a specificity fight between two modules whose load order is not
 * guaranteed, so it owns its own small style instead.
 */
export function RailToggle() {
  const content = useContent();
  const { isCollapsed, toggle } = useRail();

  return (
    <button
      type="button"
      className={styles.toggle}
      aria-expanded={!isCollapsed}
      aria-controls={RAIL_NAV_ID}
      aria-label={isCollapsed ? content.nav.expandNav : content.nav.collapseNav}
      onClick={toggle}
    >
      <Icon name={isCollapsed ? 'chevronForward' : 'chevronBack'} size="sm" />
    </button>
  );
}
