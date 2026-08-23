import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import type { NavItem } from './navigation';

/**
 * The platform-operator console's navigation, in the same shape the tenant
 * console's rail, drawer and settings tabs render from — so the rail and the
 * mobile drawer are one data source here too, and neither can drift.
 *
 * No `requiresAny` on any entry, and that is a property of the surface rather
 * than an omission. `NavItem.requiresAny` filters against a tenant *principal's*
 * permissions, and there is no principal here: `PlatformAdminGuard` authenticates
 * a shared bearer token, and every configured credential is authorised for every
 * route on it. Filtering an operator's nav would be pretending to a granularity
 * the API does not have — the honest version of that is the follow-up
 * `platform-admin.guard.ts` itself flags, a real platform-admin identity.
 *
 * Three entries and no more, because three is what the admin API answers.
 * `lib/api/admin.ts` lists the whole surface; a fourth here would be a
 * destination with nothing behind it.
 */
export const ADMIN_NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'admin-tenants',
    label: content.platformAdmin.nav.tenants,
    href: routes.adminTenants(),
    icon: 'people',
  },
  {
    id: 'admin-domains',
    label: content.platformAdmin.nav.domains,
    href: routes.adminDomains(),
    icon: 'globe',
  },
  {
    id: 'admin-webhook-events',
    label: content.platformAdmin.nav.webhookEvents,
    href: routes.adminWebhookEvents(),
    icon: 'automation',
  },
];
