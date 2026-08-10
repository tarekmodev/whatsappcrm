'use client';

import { useMemo, type ReactNode } from 'react';
import { DataTable, DataTableSkeleton, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { ASSIGNMENT_ROWS_SKELETON_COUNT } from '@/features/people/constants';
import { useContent } from '@/lib/content';
import type { TeamLoadRow } from '../assignment.data';
import { teamLoadColumnMeta } from './assignment-columns';

/** Per-team workload for a supervisor. Usage: `<TeamLoadTable rows={rows} />`. */
export function TeamLoadTable({ rows }: { rows: readonly TeamLoadRow[] }) {
  const content = useContent();

  const columns = useMemo<DataTableColumn<TeamLoadRow>[]>(() => {
    const renderers: Record<string, (row: TeamLoadRow) => ReactNode> = {
      team: (row) => <span>{row.team.name}</span>,
      members: (row) => <span>{row.team.memberUserIds.length}</span>,
      open: (row) => <span>{row.openCount}</span>,
      unread: (row) => <span>{row.unreadCount}</span>,
    };

    return teamLoadColumnMeta(content).map((meta) => ({
      ...meta,
      render: renderers[meta.key] ?? (() => null),
    }));
  }, [content]);

  if (rows.length === 0) {
    return (
      <EmptyState
        heading={content.assignment.teamLoadEmptyHeading}
        body={content.assignment.teamLoadEmptyBody}
      />
    );
  }

  return (
    <DataTable
      caption={content.assignment.teamLoadHeading}
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.team.id}
    />
  );
}

/** Same columns, same widths, same breakpoint — it is the same table. */
export function TeamLoadTableSkeleton() {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.assignment.teamLoadLoading} />
      <DataTableSkeleton
        caption={content.assignment.teamLoadHeading}
        rowCount={ASSIGNMENT_ROWS_SKELETON_COUNT}
        columns={teamLoadColumnMeta(content).map((meta) => ({ ...meta, render: () => null }))}
      />
    </>
  );
}
