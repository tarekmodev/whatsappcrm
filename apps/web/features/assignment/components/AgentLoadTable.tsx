'use client';

import { useMemo } from 'react';
import { DataTable, DataTableSkeleton, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { Badge } from '@/components/ui/Badge';
import { AgentIdentity } from '@/features/people/components/AgentIdentity';
import { AVAILABILITY_TONES, ROLE_TONES } from '@/features/people/presentation';
import { ASSIGNMENT_ROWS_SKELETON_COUNT } from '@/features/people/constants';
import { useContent } from '@/lib/content';
import type { AgentLoadRow } from '../assignment.data';
import { agentLoadColumnMeta } from './assignment-columns';

/**
 * Per-agent workload for a supervisor. Usage: `<AgentLoadTable rows={rows} />`.
 *
 * Reuses `DataTable` and `AgentIdentity` rather than a second table
 * implementation, so the mobile card layout and the name/email presentation are
 * shared with the People surface.
 */
export function AgentLoadTable({ rows }: { rows: readonly AgentLoadRow[] }) {
  const content = useContent();

  const columns = useMemo<DataTableColumn<AgentLoadRow>[]>(() => {
    const renderers: Record<string, (row: AgentLoadRow) => React.ReactNode> = {
      agent: (row) => <AgentIdentity user={row.user} />,
      role: (row) => <Badge tone={ROLE_TONES[row.user.role]}>{content.roles[row.user.role]}</Badge>,
      availability: (row) => (
        <Badge tone={AVAILABILITY_TONES[row.user.availability]}>
          {content.availability[row.user.availability]}
        </Badge>
      ),
      open: (row) => <span>{row.openCount}</span>,
      unread: (row) => <span>{row.unreadCount}</span>,
    };

    return agentLoadColumnMeta(content).map((meta) => ({
      ...meta,
      render: renderers[meta.key] ?? (() => null),
    }));
  }, [content]);

  if (rows.length === 0) {
    return (
      <EmptyState
        heading={content.assignment.agentLoadEmptyHeading}
        body={content.assignment.agentLoadEmptyBody}
      />
    );
  }

  return (
    <DataTable
      caption={content.assignment.agentLoadHeading}
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.user.id}
    />
  );
}

/** Same columns, same widths, same breakpoint — it is the same table. */
export function AgentLoadTableSkeleton() {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.assignment.agentLoadLoading} />
      <DataTableSkeleton
        caption={content.assignment.agentLoadHeading}
        rowCount={ASSIGNMENT_ROWS_SKELETON_COUNT}
        columns={agentLoadColumnMeta(content).map((meta) => ({ ...meta, render: () => null }))}
      />
    </>
  );
}
