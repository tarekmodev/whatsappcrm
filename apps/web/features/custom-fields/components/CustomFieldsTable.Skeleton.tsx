'use client';

import { DataTableSkeleton } from '@/components/ui/DataTable';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { useContent } from '@/lib/content';
import { CUSTOM_FIELDS_SKELETON_COUNT } from '../constants';
import { customFieldColumnMeta } from './custom-field-columns';

/**
 * The definition table's placeholder. Usage:
 * `<CustomFieldsTableSkeleton canManage={canManage} />`.
 *
 * Cannot drift from the table, because both build their columns from
 * `customFieldColumnMeta` — same columns, same widths, same breakpoint, same
 * `canManage` flag. A column the real table will not have is a layout shift with
 * extra steps, so the flag is threaded through rather than defaulted per file.
 *
 * Its own file, because the route's `loading.tsx` imports it statically.
 */
export function CustomFieldsTableSkeleton({ canManage = true }: { canManage?: boolean }) {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.customFields.listLoading} />
      <DataTableSkeleton
        caption={content.customFields.listHeading}
        rowCount={CUSTOM_FIELDS_SKELETON_COUNT}
        columns={customFieldColumnMeta(content, canManage).map((meta) => ({
          ...meta,
          render: () => null,
        }))}
      />
    </>
  );
}
