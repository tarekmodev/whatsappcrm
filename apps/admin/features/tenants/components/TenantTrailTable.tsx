import type { AdminTenantLifecycleEvent } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { DataTable, DataTableSkeleton, type DataTableColumn } from '@/components/ui/DataTable';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { content } from '~/content/en';
import { tenantStatusTone } from '../tenant-presentation';
import styles from './TenantTrailTable.module.css';

/**
 * A tenant's lifecycle trail — the audit log (spec §2.7). A server component over
 * `DataTable`, so it is the same table the rest of the product draws: semantic
 * `<table>`, `<th scope>`, and rows that re-flow into stacked cards below the
 * container width rather than pushing the page sideways.
 *
 * **The `reason` column is why this endpoint exists.** `GET /admin/tenants/{slug}/lifecycle`
 * differs from the tenant-facing trail by exactly one column, and it is this one:
 * "fraud, card chargeback" is what an operator writes when they shut a tenant
 * off, and ADR 0009's security section says that is not a sentence to show a
 * customer. It is capped, never dropped.
 */
const TRAIL_COLUMNS: readonly DataTableColumn<AdminTenantLifecycleEvent>[] = [
  {
    key: 'when',
    header: content.tenant.columns.when,
    isNarrow: true,
    render: (event) => (
      <RelativeTime isoTimestamp={event.occurredAt} label={content.tenant.occurredAtLabel} />
    ),
  },
  {
    key: 'change',
    header: content.tenant.columns.change,
    render: (event) => (
      <span className={styles.change}>
        {/*
          `fromStatus` is null only on a tenant's first row, and it renders the
          word rather than an empty chip — a blank where a status goes reads as
          missing data rather than as the beginning of the trail.
        */}
        {event.fromStatus === null ? (
          content.tenant.createdFrom
        ) : (
          <Badge tone={tenantStatusTone(event.fromStatus)}>
            {content.tenantStatuses[event.fromStatus]}
          </Badge>
        )}
        <span className={styles.arrow} aria-hidden="true">
          →
        </span>
        <Badge tone={tenantStatusTone(event.toStatus)}>
          {content.tenantStatuses[event.toStatus]}
        </Badge>
      </span>
    ),
  },
  {
    key: 'trigger',
    header: content.tenant.columns.trigger,
    isNarrow: true,
    // `outline` is what 0001 reserves for metadata rather than status, which is
    // exactly what a trigger is: it says *what caused* the change beside two
    // chips that say what the change was.
    render: (event) => <Badge variant="outline">{content.lifecycleTriggers[event.trigger]}</Badge>,
  },
  {
    key: 'actor',
    header: content.tenant.columns.actor,
    render: (event) =>
      event.actorLabel ??
      (event.actorType === 'unattributed' ? (
        <span className={styles.unattributed}>{content.tenant.backfilled}</span>
      ) : (
        content.lifecycleActors[event.actorType]
      )),
  },
  {
    key: 'reason',
    header: content.tenant.columns.reason,
    // A null reason renders **nothing** — not "—". Most rows have none, and a
    // column of dashes is a column of noise.
    render: (event) =>
      event.reason === null ? null : (
        <span className={styles.reason} title={event.reason}>
          {event.reason}
        </span>
      ),
  },
];

export function TenantTrailTable({ events }: { events: readonly AdminTenantLifecycleEvent[] }) {
  return (
    <DataTable
      caption={content.tenant.historyCaption}
      columns={TRAIL_COLUMNS}
      rows={events}
      getRowKey={(event) => event.id}
      unstackAt="wide"
    />
  );
}

/**
 * The trail's placeholder. Reuses `DataTable`'s own skeleton with the *same*
 * column set, so header widths, sort affordances and the stacking threshold are
 * shared by construction and the swap to real rows shifts nothing.
 *
 * `rowCount` matches `CursorPageQuerySchema`'s default limit, which is the page
 * the read actually asks for.
 */
export const TRAIL_PAGE_SIZE = 25;

export function TenantTrailTableSkeleton() {
  return (
    <DataTableSkeleton
      caption={content.tenant.historyCaption}
      columns={TRAIL_COLUMNS}
      rowCount={TRAIL_PAGE_SIZE}
      unstackAt="wide"
    />
  );
}
