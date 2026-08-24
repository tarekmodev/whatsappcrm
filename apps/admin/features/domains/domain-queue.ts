import { ADMIN_DOMAIN_QUERY_STATUSES, type AdminDomainStatus } from '@whatsappcrm/contracts';
import type { SelectOption } from '@/components/ui/Select';
import { content } from '~/content/en';
import { DOMAIN_STATUS_DEFAULT, routes } from '~/lib/routes';

/**
 * The queue's two halves as `Select` options, and the link each one is.
 *
 * In its own module because the section **and its skeleton** both render the
 * filter: it is a control whose values are known before the read returns, so the
 * placeholder shows the real thing rather than a shimmer standing in for one —
 * and the table below does not move by a row when the data lands.
 *
 * Built from the query's own enum rather than listed, so a third half added to
 * `ADMIN_DOMAIN_QUERY_STATUSES` arrives here with no change.
 */
export function domainQueueOptions(): readonly SelectOption[] {
  return ADMIN_DOMAIN_QUERY_STATUSES.map((status) => ({
    value: status,
    label: content.domains.statuses[status],
  }));
}

/**
 * Where a half lives. The default half is the **bare route**: a parameter saying
 * exactly what the API would have done anyway is one more thing in a shared URL
 * that means nothing to whoever receives it.
 */
export function domainQueueHref(status: AdminDomainStatus): string {
  return routes.domains(status === DOMAIN_STATUS_DEFAULT ? undefined : { status });
}
