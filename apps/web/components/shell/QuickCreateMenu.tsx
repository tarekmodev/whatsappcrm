'use client';

import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { MenuButton } from '@/components/ui/MenuButton';
import { useContent } from '@/lib/content';
import type { QuickCreateItem } from './quick-create';
import styles from './QuickCreateMenu.module.css';

/**
 * The top bar's quick-create control. Usage:
 * `<QuickCreateMenu items={visibleQuickCreateItems(QUICK_CREATE_ITEMS, checker)} />`.
 *
 * Renders nothing for a principal with nothing to create — an agent, today. A
 * `+` that opens an empty panel is worse than no `+`, and this is the same rule
 * `FilterPills` follows for a single-scope role.
 */
export function QuickCreateMenu({ items }: { items: readonly QuickCreateItem[] }) {
  const content = useContent();

  if (items.length === 0) {
    return null;
  }

  return (
    <MenuButton
      label={<Icon name="plus" />}
      accessibleName={content.quickCreate.label}
      triggerClassName={styles.trigger}
    >
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.id}>
            <Link href={item.href} className={styles.item}>
              <Icon name={item.icon} size="sm" />
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </MenuButton>
  );
}
