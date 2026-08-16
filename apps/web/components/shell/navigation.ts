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
    id: 'settings-workspace',
    label: content.nav.workspace,
    href: routes.settingsWorkspace(),
    // `info`, not `settings`: the parent Settings entry already carries that
    // one, and the mobile drawer renders parent and children together.
    icon: 'info',
    /**
     * Either permission, because the page is two surfaces with two gates: the
     * plan panel reads `GET /tenant/lifecycle` (`tenant:settings`) and the
     * profile form writes `PATCH /tenant` (`branding:write`). Both are
     * admin-only under today's role table, so the union changes nothing now —
     * it is what stops a custom role that holds one of them from being sent to
     * a 403 for a surface it can half use.
     */
    requiresAny: ['tenant:settings', 'branding:write'],
  },
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
    id: 'settings-workflows',
    label: content.nav.workflows,
    href: routes.settingsWorkflows(),
    icon: 'automation',
    // The permission the endpoints behind it require (ADR 0009). `workflow:read`
    // alone is enough to see the list; writing is gated separately on the page.
    requiresAny: ['workflow:read'],
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
    id: 'settings-branding',
    label: content.nav.branding,
    href: routes.settingsBranding(),
    icon: 'settings',
    // The same permission `PATCH /api/v1/tenant` and the two asset routes
    // require (TAR-29).
    requiresAny: ['branding:write'],
  },
  {
    id: 'settings-domains',
    label: content.nav.domains,
    href: routes.settingsDomains(),
    icon: 'security',
    // Deliberately not `branding:write`: DNS control decides where every invite
    // and password-reset link in the tenant is sent.
    requiresAny: ['domain:write'],
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
    id: 'reports',
    label: content.nav.reports,
    href: routes.reports(),
    icon: 'reports',
    // Every role holds `report:read`; what a supervisor holds on top is
    // `report:read_all`, which widens the aggregate and the per-agent breakdown
    // rather than deciding whether the destination exists (ADR 0009 decision 6).
    requiresAny: ['report:read'],
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
  {
    id: 'onboarding',
    label: content.nav.onboarding,
    href: routes.onboarding(),
    icon: 'checklist',
    /*
     * Last, so the destinations an admin uses every day keep their positions, and
     * gated on the permission the checklist's own endpoint requires — an agent or
     * a supervisor never sees an entry the API would refuse.
     *
     * Deliberately *not* hidden once the checklist is finished. TAR-36 requires a
     * skipped step to be returnable, and a nav entry that disappears the moment
     * the last step resolves takes the way back with it. The page's own completed
     * state is what says there is nothing left to do.
     */
    requiresAny: ['tenant:settings'],
  },
];

/**
 * How many rail entries are shown before the More/Less boundary.
 *
 * Five, because 0001 rules the rail's destinations to be exactly Inbox,
 * Contacts, Tickets, Reports and Settings. Anything a later story adds beyond
 * that set is a destination somebody asked for rather than one everybody needs,
 * and belongs behind the disclosure. `NavLinkList` renders no boundary while
 * nothing sorts past this, so today — Inbox, Tickets, Reports, Settings and the
 * onboarding checklist — the rail still shows whole, and the next entry after
 * them is the first one the disclosure hides.
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
