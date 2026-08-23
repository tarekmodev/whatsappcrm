import type { AdminTenantLifecycleEvent, TenantStatus } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { content } from '@/content/en';
import { tenantStatusTone } from '../tenant-presentation';

/**
 * What state a tenant is in, and when it last moved. Usage:
 * `<TenantStatePanel status={status} latest={latest} />`.
 *
 * A server component: it renders values its caller already read, and pulls
 * nothing into the client bundle.
 *
 * `status` is `null` for a tenant whose trail is empty. That is rendered as
 * "Not recorded" with a line saying why, rather than as a guess — an operator
 * about to suspend a customer's workspace should not be shown a state the console
 * inferred from nothing. `tenantActions` refuses both actions in the same case.
 */
export function TenantStatePanel({
  status,
  latest,
}: {
  status: TenantStatus | null;
  /** The newest row of the trail, or `null` when there is none. */
  latest: AdminTenantLifecycleEvent | null;
}) {
  const copy = content.platformAdmin.tenant;

  const items: DetailListItem[] = [
    {
      id: 'status',
      term: copy.statusLabel,
      value:
        status === null ? (
          copy.statusUnknown
        ) : (
          <Badge tone={tenantStatusTone(status)} size="md">
            {content.platformAdmin.tenantStatuses[status]}
          </Badge>
        ),
      ...(status === null ? { hint: copy.statusUnknownHint } : {}),
    },
  ];

  if (latest !== null) {
    items.push({
      id: 'last-changed',
      term: copy.lastChangedLabel,
      value: <RelativeTime isoTimestamp={latest.occurredAt} label={copy.occurredAtLabel} />,
      // The credential label, or the tenant admin's email at the time. Naming it
      // beside the instant is what makes the panel answer "who did this" without
      // the operator dropping into the table below.
      hint: copy.lastChangedBy(
        latest.actorLabel ?? content.platformAdmin.lifecycleActors[latest.actorType],
      ),
    });
  }

  return <DetailList items={items} />;
}
