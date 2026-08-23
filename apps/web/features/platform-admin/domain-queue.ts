import { ADMIN_DOMAIN_QUERY_STATUSES, type AdminDomainStatus } from '@whatsappcrm/contracts';
import type { FilterPillItem } from '@/components/ui/FilterPills';
import { content } from '@/content/en';
import { ADMIN_DOMAIN_STATUS_DEFAULT, routes } from '@/lib/routes';

/**
 * The domain queue's two halves, as pills.
 *
 * In its own module because the section **and its skeleton** both render them:
 * the strip is a row of links whose targets are known before the read returns,
 * so the placeholder shows the real control rather than a shimmer standing in for
 * one — and the swap to loaded content does not move the table down by a line.
 *
 * Built from the query's own enum rather than listed, so a third half added to
 * `ADMIN_DOMAIN_QUERY_STATUSES` arrives here with no change.
 */
export function domainQueuePills(current: AdminDomainStatus): readonly FilterPillItem[] {
  const copy = content.platformAdmin.domains;

  return ADMIN_DOMAIN_QUERY_STATUSES.map((status) => ({
    id: status,
    label: copy.statuses[status],
    // The default half links to the bare route: a parameter that says exactly
    // what the API would have done anyway is one more thing in a shared URL that
    // means nothing to whoever receives it.
    href: routes.adminDomains(status === ADMIN_DOMAIN_STATUS_DEFAULT ? undefined : { status }),
    isCurrent: current === status,
  }));
}
