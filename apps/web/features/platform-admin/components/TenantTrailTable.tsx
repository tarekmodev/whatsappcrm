import type { AdminTenantLifecycleEvent } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { DataTable, DataTableSkeleton, type DataTableColumn } from '@/components/ui/DataTable';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { content } from '@/content/en';
import { tenantStatusTone } from '../tenant-presentation';

/**
 * A tenant's lifecycle trail — the audit log an operator reads. Usage:
 * `<TenantTrailTable events={page.items} />`.
 *
 * A server component over `DataTable`, so it is the same table the rest of the
 * app draws: semantic `<table>`, `<th scope>`, and rows that re-flow into stacked
 * cards below the container width rather than pushing the page sideways.
 *
 * `unstackAt="wide"` because five columns — one of them free text — need more
 * room than the default threshold gives them, and un-stacking into a space they
 * do not fit is what makes the *document* scroll at tablet widths.
 *
 * ## `reason` is the reason this table exists rather than the tenant's own
 *
 * `GET /admin/tenants/{slug}/lifecycle` differs from the tenant-facing
 * `GET /tenant/lifecycle/events` by exactly one column, and it is this one:
 * "fraud, card chargeback" is what an operator writes when they shut a tenant
 * off, and ADR 0009's security section says that is not a sentence to show a
 * customer.
 */

const TRAIL_COLUMNS: readonly DataTableColumn<AdminTenantLifecycleEvent>[] = [
  {
    key: 'change',
    header: content.platformAdmin.tenant.columns.change,
    render: (event) => (
      <span>
        {event.fromStatus === null
          ? null
          : `${content.platformAdmin.tenantStatuses[event.fromStatus]} → `}
        {/*
          One chip per row, on the state the row *arrived at* — 0001's status
          vocabulary allows a list row exactly one, and where it went is the
          thing being scanned for. The state it came from stays plain text
          beside it, which also keeps the transition readable in forced-colors
          mode where the chip's tint is gone.
        */}
        <Badge tone={tenantStatusTone(event.toStatus)}>
          {content.platformAdmin.tenantStatuses[event.toStatus]}
        </Badge>
      </span>
    ),
  },
  {
    key: 'trigger',
    header: content.platformAdmin.tenant.columns.trigger,
    isNarrow: true,
    render: (event) => content.platformAdmin.lifecycleTriggers[event.trigger],
  },
  {
    key: 'actor',
    header: content.platformAdmin.tenant.columns.actor,
    render: (event) =>
      // The credential label or the admin's email at the time. The actor *type*
      // is the fallback rather than a second column: on an attributed row it says
      // nothing the label does not, and on an unattributed one it is all there is.
      event.actorLabel ?? content.platformAdmin.lifecycleActors[event.actorType],
  },
  {
    key: 'reason',
    header: content.platformAdmin.tenant.columns.reason,
    render: (event) => event.reason ?? content.platformAdmin.tenant.noReason,
  },
  {
    key: 'occurredAt',
    header: content.platformAdmin.tenant.columns.occurredAt,
    isNarrow: true,
    render: (event) => (
      <RelativeTime
        isoTimestamp={event.occurredAt}
        label={content.platformAdmin.tenant.occurredAtLabel}
      />
    ),
  },
];

export function TenantTrailTable({ events }: { events: readonly AdminTenantLifecycleEvent[] }) {
  return (
    <DataTable
      caption={content.platformAdmin.tenant.trailCaption}
      columns={TRAIL_COLUMNS}
      rows={events}
      getRowKey={(event) => event.id}
      unstackAt="wide"
    />
  );
}

/**
 * The trail's placeholder. Reuses `DataTable`'s own skeleton with the *same*
 * column set, so the header widths, the sort affordances and the stacking
 * threshold are shared by construction and the swap to real rows shifts nothing.
 *
 * `rowCount` matches `CursorPageQuerySchema`'s default limit, which is the page
 * the read actually asks for.
 */
export const TRAIL_PAGE_SIZE = 25;

export function TenantTrailTableSkeleton() {
  return (
    <DataTableSkeleton
      caption={content.platformAdmin.tenant.trailCaption}
      columns={TRAIL_COLUMNS}
      rowCount={TRAIL_PAGE_SIZE}
      unstackAt="wide"
    />
  );
}
