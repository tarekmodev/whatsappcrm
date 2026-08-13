import type { Permission } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import type { IconName } from '@/components/ui/Icon';
import type { PermissionChecker } from '@/lib/session/permissions';

/**
 * The single navigation data source. The rail, the mobile drawer and the
 * settings tabs all render from this — duplicating the markup for mobile is what
 * makes the two drift.
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
   * Shown beside the label in the rail, and alone once the rail is collapsed.
   * A top-level entry without one is unreachable when collapsed, so the rail's
   * own entries always carry it; a child entry, which never renders in the
   * rail, may leave it out.
   */
  readonly icon?: IconName;
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
    icon: 'people',
    // `user:read` alone is not enough: an agent holds it for @mentions and
    // assignee pickers, but managing people is a supervisor/admin surface.
    requiresAny: ['user:invite', 'user:update', 'team:write'],
  },
  {
    id: 'settings-assignment',
    label: content.nav.assignment,
    href: routes.settingsAssignment(),
    icon: 'reports',
    requiresAny: ['report:read_all', 'assignment_rule:read'],
  },
  {
    id: 'settings-whatsapp',
    label: content.nav.whatsapp,
    href: routes.settingsWhatsApp(),
    icon: 'conversation',
    // The same permission the endpoint behind it requires. A principal without it
    // never sees the entry, and the API refuses the call regardless (TAR-169).
    requiresAny: ['channel:manage'],
  },
  {
    id: 'settings-security',
    label: content.nav.security,
    href: routes.settingsSecurity(),
    icon: 'security',
    // Everyone. See `requiresAny` above — an agent who cannot reach this page
    // has no way to change their own password.
  },
];

/**
 * The rail, in order. 0001 rules the destinations this console is heading for —
 * Inbox, Contacts, Tickets, Reports, Settings — and each is added here, with its
 * icon, by the story that builds the route behind it. An entry added ahead of
 * its route is a nav link to a 404.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'inbox',
    label: content.nav.inbox,
    href: routes.inbox(),
    icon: 'inbox',
    // Every role has this; the inbox is an agent's home.
    requiresAny: ['conversation:read'],
  },
  {
    id: 'tickets',
    label: content.nav.tickets,
    href: routes.tickets(),
    icon: 'ticket',
    // Every role has this; a ticket is the unit of work an agent is measured on.
    requiresAny: ['ticket:read'],
  },
  {
    id: 'settings',
    label: content.nav.settings,
    href: routes.settings(),
    icon: 'settings',
    // Derived from the children rather than restated, so a settings section added
    // later cannot forget to widen its parent.
    requiresAny: derivedRequirements(SETTINGS_CHILDREN),
    children: SETTINGS_CHILDREN,
  },
];

/**
 * How many rail entries are shown before the More/Less boundary.
 *
 * Five, because 0001 rules the rail's destinations to be exactly Inbox,
 * Contacts, Tickets, Reports and Settings. Anything a later story adds beyond
 * that set is a destination somebody asked for rather than one everybody needs,
 * and belongs behind the disclosure. `NavLinkList` renders no boundary while the
 * array is shorter than this, so today — two entries — the rail shows whole.
 */
export const RAIL_PRIMARY_COUNT = 5;

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
