'use client';

import { DataTableSkeleton } from '@/components/ui/DataTable';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { useContent } from '@/lib/content';
import { FLAGGED_TICKETS_SKELETON_COUNT } from '../constants';
import { flaggedTicketColumnMeta } from './flagged-columns';

/**
 * The flagged queue's placeholder. Usage:
 * `<FlaggedTicketsTableSkeleton hasRowActions={hasRowActions} />`.
 *
 * Its own file, not an export beside the table, and that is load-bearing: the
 * lazy boundary imports this statically as its fallback, so a shared module would
 * drag the table's whole chunk into the route bundle and the `dynamic()` call
 * would split nothing. Verified against the build output rather than assumed.
 *
 * It cannot drift from the table, because both build their columns from
 * `flaggedTicketColumnMeta` — same columns, same widths, same breakpoint, same
 * `hasRowActions` flag. A column the real table will not have is a layout shift with
 * extra steps, so the flag is threaded through rather than defaulted per file.
 */
export function FlaggedTicketsTableSkeleton({ hasRowActions = true }: { hasRowActions?: boolean }) {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.assignment.flaggedLoading} />
      <DataTableSkeleton
        caption={content.assignment.flaggedHeading}
        rowCount={FLAGGED_TICKETS_SKELETON_COUNT}
        columns={flaggedTicketColumnMeta(content, hasRowActions).map((meta) => ({
          ...meta,
          render: () => null,
        }))}
      />
    </>
  );
}
