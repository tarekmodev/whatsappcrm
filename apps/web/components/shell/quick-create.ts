import type { Permission } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import type { IconName } from '@/components/ui/Icon';
import type { PermissionChecker } from '@/lib/session/permissions';

/**
 * What the top bar's `+` offers, as data — the same arrangement as
 * `navigation.ts`, and for the same reason: one array, filtered once on the
 * server, rendered by whatever needs it.
 *
 * Every entry is a **link to a surface that exists**. There is no "new
 * conversation" here, and there will not be one until an endpoint can start an
 * outbound thread: a customer writing in is what creates a conversation in this
 * product, so an agent pressing `+` has nothing to create.
 *
 * An entry is added by the story that builds the thing it creates, which is what
 * keeps this from becoming a menu of 404s.
 */

export interface QuickCreateItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly icon: IconName;
  /** Rendered only if the principal holds at least one of these. */
  readonly requiresAny: readonly Permission[];
}

export const QUICK_CREATE_ITEMS: readonly QuickCreateItem[] = [
  {
    id: 'invite-person',
    label: content.quickCreate.invitePerson,
    href: routes.settingsPeople({ tab: 'agents' }),
    icon: 'people',
    requiresAny: ['user:invite'],
  },
  {
    id: 'create-team',
    label: content.quickCreate.createTeam,
    href: routes.settingsPeople({ tab: 'teams' }),
    icon: 'people',
    requiresAny: ['team:write'],
  },
  {
    id: 'connect-whatsapp',
    label: content.quickCreate.connectWhatsApp,
    href: routes.settingsWhatsApp(),
    icon: 'conversation',
    requiresAny: ['channel:manage'],
  },
];

/**
 * Drops every entry the principal may not act on. An agent holds none of these
 * permissions, so their bar carries no `+` at all — which is the right answer,
 * not a gap: `QuickCreateMenu` renders nothing for an empty list.
 */
export function visibleQuickCreateItems(
  items: readonly QuickCreateItem[],
  checker: PermissionChecker,
): readonly QuickCreateItem[] {
  return items.filter((item) => checker.canAny(item.requiresAny));
}
