import type { Permission } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import type { PermissionChecker } from '@/lib/session/permissions';

/**
 * The single navigation data source. Desktop nav, mobile drawer and the settings
 * sub-nav all render from this — duplicating the markup for mobile is what makes
 * the two drift.
 *
 * `requiresAny` is the whole of TAR-22's third acceptance criterion in the UI: an
 * entry is rendered only when the principal holds one of its permissions, so a
 * non-admin never sees a link to a tenant-admin surface at all.
 */

export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  /** Rendered only if the principal holds at least one of these. */
  readonly requiresAny: readonly Permission[];
  readonly children?: readonly NavItem[];
}

const SETTINGS_CHILDREN: readonly NavItem[] = [
  {
    id: 'settings-people',
    label: content.nav.people,
    href: routes.settingsPeople(),
    // `user:read` alone is not enough: an agent holds it for @mentions and
    // assignee pickers, but managing people is a supervisor/admin surface.
    requiresAny: ['user:invite', 'user:update', 'team:write'],
  },
  {
    id: 'settings-assignment',
    label: content.nav.assignment,
    href: routes.settingsAssignment(),
    requiresAny: ['report:read_all', 'assignment_rule:read'],
  },
];

export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'inbox',
    label: content.nav.inbox,
    href: routes.inbox(),
    // Every role has this; the inbox is an agent's home.
    requiresAny: ['conversation:read'],
  },
  {
    id: 'settings',
    label: content.nav.settings,
    href: routes.settings(),
    // Derived from the children rather than restated, so a settings section added
    // later cannot forget to widen its parent.
    requiresAny: SETTINGS_CHILDREN.flatMap((child) => child.requiresAny),
    children: SETTINGS_CHILDREN,
  },
];

/** Drops every entry — and every child — the principal may not reach. */
export function visibleNavItems(
  items: readonly NavItem[],
  checker: PermissionChecker,
): readonly NavItem[] {
  return (
    items
      .filter((item) => checker.canAny(item.requiresAny))
      .map((item) =>
        item.children === undefined
          ? item
          : { ...item, children: visibleNavItems(item.children, checker) },
      )
      // A parent whose every child was filtered out is not a destination.
      .filter((item) => item.children === undefined || item.children.length > 0)
  );
}

export function settingsNavItems(checker: PermissionChecker): readonly NavItem[] {
  return visibleNavItems(SETTINGS_CHILDREN, checker);
}
