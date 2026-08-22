'use client';

import { DataTableSkeleton } from '@/components/ui/DataTable';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { useContent } from '@/lib/content';
import { CANNED_RESPONSES_SKELETON_COUNT } from '../constants';
import { cannedResponseColumnMeta } from './canned-response-columns';

/**
 * The saved-reply table's placeholder. Usage:
 * `<CannedResponsesTableSkeleton canManage={canManage} />`.
 *
 * Cannot drift from the table, because both build their columns from
 * `cannedResponseColumnMeta` — same columns, same widths, same breakpoint, same
 * `canManage` flag. A column the real table will not have is a layout shift with
 * extra steps, so the flag is threaded through rather than defaulted per file.
 *
 * Its own file, because the route's `loading.tsx` imports it statically.
 */
export function CannedResponsesTableSkeleton({ canManage = true }: { canManage?: boolean }) {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.cannedResponses.listLoading} />
      <DataTableSkeleton
        caption={content.cannedResponses.listHeading}
        rowCount={CANNED_RESPONSES_SKELETON_COUNT}
        columns={cannedResponseColumnMeta(content, canManage).map((meta) => ({
          ...meta,
          render: () => null,
        }))}
      />
    </>
  );
}
