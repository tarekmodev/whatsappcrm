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
  /**
   * Rendered only if the principal holds at least one of these.
   *
   * `undefined` means every signed-in principal, and it is not the same as an
   * empty array — `canAny([])` is false, so an empty list would hide the entry
   * from everyone. It is for a surface whose subject is the *caller* rather than
   * the tenant: changing your own password is gated by no permission, because
   * there is no role that should be unable to do it.
   */
  readonly requiresAny?: readonly Permission[];
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
  {
    id: 'settings-whatsapp',
    label: content.nav.whatsapp,
    href: routes.settingsWhatsApp(),
    // The same permission the endpoint behind it requires. A principal without it
    // never sees the entry, and the API refuses the call regardless (TAR-169).
    requiresAny: ['channel:manage'],
  },
  {
    id: 'settings-security',
    label: content.nav.security,
    href: routes.settingsSecurity(),
    // Everyone. See `requiresAny` above — an agent who cannot reach this page
    // has no way to change their own password.
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
    requiresAny: derivedRequirements(SETTINGS_CHILDREN),
    children: SETTINGS_CHILDREN,
  },
];

/**
 * The union of what a parent's children need — or `undefined` when any one child
 * is open to everyone, because a parent narrower than a child it contains would
 * hide a destination the principal is allowed to reach.
 */
function derivedRequirements(children: readonly NavItem[]): readonly Permission[] | undefined {
  return children.some((child) => child.requiresAny === undefined)
    ? undefined
    : children.flatMap((child) => child.requiresAny ?? []);
}

/** Drops every entry — and every child — the principal may not reach. */
export function visibleNavItems(
  items: readonly NavItem[],
  checker: PermissionChecker,
): readonly NavItem[] {
  return (
    items
      .filter((item) => item.requiresAny === undefined || checker.canAny(item.requiresAny))
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
