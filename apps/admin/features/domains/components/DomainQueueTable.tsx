'use client';

import { useCallback, useState } from 'react';
import type { AdminDomainStatus, AdminPendingDomain } from '@whatsappcrm/contracts';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { Badge } from '@/components/ui/Badge';
import { DataTable, DataTableSkeleton, type DataTableColumn } from '@/components/ui/DataTable';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Stack } from '@/components/layout/Stack';
import { TextLink } from '@/components/ui/TextLink';
import { content } from '~/content/en';
import { routes } from '~/lib/routes';
import { DomainRowActions } from './DomainRowActions';
import styles from './DomainQueueTable.module.css';

/**
 * The custom-domain activation queue (spec §2.3, region 2) — the **one real
 * cross-tenant list this API serves**, and genuinely operational work.
 *
 * A client component, unusually for a table on this surface, and the reason is
 * the failure path: a row's write can fail *after* a sibling's success has
 * refetched the queue and moved this row to the other half, so the message has to
 * live above the table rather than inside a row that may no longer be there. That
 * is one piece of state, and it is what this component owns.
 *
 * The tenant cell links through. This queue is the only place in the console
 * where a tenant can be *found* rather than typed, which is why the lookup screen
 * points at it.
 */
export function DomainQueueTable({
  domains,
  status,
}: {
  domains: readonly AdminPendingDomain[];
  status: AdminDomainStatus;
}) {
  const [failure, setFailure] = useState<{ hostname: string; message: string } | null>(null);

  const onFailure = useCallback((hostname: string, message: string) => {
    setFailure({ hostname, message });
  }, []);

  return (
    <Stack gap="4">
      {failure === null ? null : (
        <AlertBanner tone="danger" heading={content.domains.actionFailed(failure.hostname)}>
          {failure.message}
        </AlertBanner>
      )}
      <DataTable
        caption={content.domains.caption}
        columns={queueColumns(status, onFailure)}
        rows={domains}
        // A hostname is unique across the platform, which makes it the identity
        // of the row as well as the API's path parameter.
        getRowKey={(domain) => domain.hostname}
        unstackAt="wide"
      />
    </Stack>
  );
}

/**
 * Built per render rather than hoisted, because the action column depends on
 * which half is showing — a module-level constant closing over a prop would be
 * the same table for both halves.
 */
function queueColumns(
  status: AdminDomainStatus,
  onFailure: (hostname: string, message: string) => void,
): readonly DataTableColumn<AdminPendingDomain>[] {
  return [
    {
      key: 'tenant',
      header: content.domains.columns.tenant,
      render: (domain) => (
        <span className={styles.tenant}>
          <TextLink href={routes.tenant(domain.tenantSlug)}>{domain.tenantName}</TextLink>
          {/* The slug beneath the name: the name is what an operator recognises,
              the slug is what the rest of the console keys on. */}
          <span className={styles.slug}>{domain.tenantSlug}</span>
        </span>
      ),
    },
    {
      key: 'hostname',
      header: content.domains.columns.hostname,
      render: (domain) => (
        <span className={styles.hostname} title={domain.hostname}>
          {domain.hostname}
        </span>
      ),
    },
    {
      key: 'verified',
      header: content.domains.columns.verified,
      isNarrow: true,
      render: (domain) => (
        <RelativeTime isoTimestamp={domain.verifiedAt} label={content.domains.columns.verified} />
      ),
    },
    {
      key: 'status',
      header: content.domains.columns.status,
      isNarrow: true,
      // One chip, derived from the row rather than from the filter — the filter
      // says which half, this says what is true of this row.
      render: (domain) =>
        domain.activatedAt === null ? (
          <Badge tone="warning">{content.domains.statuses.verified}</Badge>
        ) : (
          <Badge tone="success">{content.domains.statuses.live}</Badge>
        ),
    },
    {
      key: 'actions',
      header: content.domains.columns.actions,
      // The column keeps its header for the stacked card layout and for
      // screen-reader table commands; on screen the buttons name themselves.
      isHeaderHidden: true,
      isNarrow: true,
      render: (domain) => (
        <DomainRowActions domain={domain} status={status} onFailure={onFailure} />
      ),
    },
  ];
}

/**
 * The queue's placeholder, from the same column set so header widths and the
 * stacking threshold cannot drift from the real table's.
 *
 * The row count is a guess and says so: `GET /admin/domains` is unpaged — it
 * returns whatever is waiting — so there is no page size to match. Six is a queue
 * somebody is about to work through; a placeholder taller than the real list
 * collapses when it lands, and one row flashes.
 */
const PLACEHOLDER_ROWS = 6;

export function DomainQueueTableSkeleton({ status }: { status: AdminDomainStatus }) {
  return (
    <DataTableSkeleton
      caption={content.domains.caption}
      columns={queueColumns(status, () => {})}
      rowCount={PLACEHOLDER_ROWS}
      unstackAt="wide"
    />
  );
}
