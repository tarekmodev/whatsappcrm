import type { AdminDomainStatus, AdminPendingDomain } from '@whatsappcrm/contracts';
import { DataTable, DataTableSkeleton, type DataTableColumn } from '@/components/ui/DataTable';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { TextLink } from '@/components/ui/TextLink';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { DomainQueueRowActions } from './DomainQueueRowActions';

/**
 * The operator's custom-domain queue. Usage:
 * `<DomainQueueTable domains={domains} status={status} />`.
 *
 * A server component over `DataTable`, with one client island per row for the
 * action. The columns are built per render rather than hoisted to a constant,
 * because the action column depends on which half of the queue is showing — and
 * a module-level constant that closed over a prop would be the same table for
 * both halves.
 *
 * The tenant cell links to that tenant's screen. This queue is the only
 * cross-tenant list the admin API publishes, so it is also the only place in the
 * console where a tenant can be *found* rather than typed — worth a link, and the
 * reason the lookup form is not the sole way in.
 */

function queueColumns(status: AdminDomainStatus): readonly DataTableColumn<AdminPendingDomain>[] {
  const copy = content.platformAdmin.domains;

  return [
    {
      key: 'hostname',
      header: copy.columns.hostname,
      render: (domain) => domain.hostname,
    },
    {
      key: 'tenant',
      header: copy.columns.tenant,
      render: (domain) => (
        // The name is what an operator recognises; the slug is what the rest of
        // the console keys on, and it is already in the link's href. Showing both
        // would be a cell that says the same thing twice at two widths.
        <TextLink href={routes.adminTenant(domain.tenantSlug)}>{domain.tenantName}</TextLink>
      ),
    },
    {
      key: 'verifiedAt',
      header: copy.columns.verifiedAt,
      isNarrow: true,
      render: (domain) => (
        <RelativeTime isoTimestamp={domain.verifiedAt} label={copy.verifiedAtLabel} />
      ),
    },
    {
      key: 'activatedAt',
      header: copy.columns.activatedAt,
      isNarrow: true,
      render: (domain) =>
        domain.activatedAt === null ? (
          copy.notAttached
        ) : (
          <RelativeTime isoTimestamp={domain.activatedAt} label={copy.activatedAtLabel} />
        ),
    },
    {
      key: 'actions',
      header: copy.columns.actions,
      // The column has a header for the stacked card layout and for screen-reader
      // table commands; on screen the buttons name themselves.
      isHeaderHidden: true,
      isNarrow: true,
      render: (domain) => <DomainQueueRowActions domain={domain} status={status} />,
    },
  ];
}

export function DomainQueueTable({
  domains,
  status,
}: {
  domains: readonly AdminPendingDomain[];
  status: AdminDomainStatus;
}) {
  return (
    <DataTable
      caption={content.platformAdmin.domains.caption}
      columns={queueColumns(status)}
      rows={domains}
      // A hostname is unique across the platform, which is what makes it the
      // identity of the row as well as the API's path parameter.
      getRowKey={(domain) => domain.hostname}
      unstackAt="wide"
    />
  );
}

/**
 * The queue's placeholder, built from the same column set so the header widths
 * and the stacking threshold cannot drift from the real table's.
 *
 * The row count is a guess and says so: `GET /admin/domains` is unpaged — it
 * returns whatever is waiting — so there is no page size to match. Six rows is
 * a queue somebody is about to work through; a placeholder taller than the real
 * list would collapse when it lands, and one row would flash.
 */
const PLACEHOLDER_ROWS = 6;

export function DomainQueueTableSkeleton({ status }: { status: AdminDomainStatus }) {
  return (
    <DataTableSkeleton
      caption={content.platformAdmin.domains.caption}
      columns={queueColumns(status)}
      rowCount={PLACEHOLDER_ROWS}
      unstackAt="wide"
    />
  );
}
