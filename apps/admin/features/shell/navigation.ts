import type { NavItem } from '@/components/shell/navigation';
import { content } from '~/content/en';
import { routes } from '~/lib/routes';

/**
 * The operator console's navigation, in the same shape `apps/web`'s rail and
 * drawer render from — so this app has one data source at every width too, and
 * the shared `NavLinkList` marks the current entry the same way.
 *
 * **Three entries, in this order** (spec §2.1), and each is added by the story
 * that builds its route: an entry ahead of its route is a link to a 404.
 *
 * No `requiresAny` on any of them, and that is a property of the surface rather
 * than an omission. That field filters against a tenant *principal's*
 * permissions, and there is no principal here — every configured credential is
 * authorised for every route. Filtering an operator's nav would be pretending to
 * a granularity the API does not have.
 */
export const ADMIN_NAV_ITEMS: readonly NavItem[] = [
  { id: 'tenants', label: content.nav.tenants, href: routes.tenants(), icon: 'people' },
  { id: 'domains', label: content.nav.domains, href: routes.domains(), icon: 'globe' },
  { id: 'webhooks', label: content.nav.webhooks, href: routes.webhooks(), icon: 'automation' },
];
