'use client';

import { NavLinkList } from './NavLinkList';
import type { NavItem } from './navigation';
import { useRail } from './AppShell';

/**
 * The rail's link list. Usage: `<RailNav items={items} />`.
 *
 * Exists only to read the rail's width from context and hand it to the shared
 * `NavLinkList` — which stays context-free, so the mobile drawer and the tests
 * can render it without a shell around it.
 */
export function RailNav({ items }: { items: readonly NavItem[] }) {
  const { isCollapsed } = useRail();

  return (
    <NavLinkList items={items} orientation="vertical" appearance="rail" isCollapsed={isCollapsed} />
  );
}
