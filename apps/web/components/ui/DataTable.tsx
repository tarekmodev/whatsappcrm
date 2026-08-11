import type { ReactNode } from 'react';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { SkeletonLine } from './Skeleton';
import styles from './DataTable.module.css';

/**
 * The one table in the app. Usage:
 *
 * ```tsx
 * <DataTable caption="Agents" columns={AGENT_COLUMNS} rows={users} getRowKey={(u) => u.id} />
 * ```
 *
 * Semantic `<table>` with a real caption and `<th scope>`, so it is navigable by
 * screen-reader table commands. Below the layout breakpoint each row re-flows into
 * a stacked card, with the column header repeated per cell through
 * `data-label` — no duplicate mobile markup and no horizontal scroll at 320px.
 */

export interface DataTableColumn<Row> {
  /** Stable key, also the `data-label` source for the stacked card layout. */
  key: string;
  header: string;
  render: (row: Row) => ReactNode;
  /** Header is for assistive technology only — use for an actions column. */
  isHeaderHidden?: boolean;
  /** Shrinks to content instead of sharing the free space. */
  isNarrow?: boolean;
}

export interface DataTableProps<Row> {
  /** The table's accessible name. Visually hidden unless `isCaptionVisible`. */
  caption: string;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowKey: (row: Row) => string;
  isCaptionVisible?: boolean;
}

export function DataTable<Row>({
  caption,
  columns,
  rows,
  getRowKey,
  isCaptionVisible = false,
}: DataTableProps<Row>) {
  return (
    <table className={styles.table}>
      <caption className={styles.caption} data-visible={isCaptionVisible ? 'true' : undefined}>
        {caption}
      </caption>
      <thead className={styles.head}>
        <tr>
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={styles.headerCell}
              data-narrow={column.isNarrow ? 'true' : undefined}
            >
              {column.isHeaderHidden === true ? (
                <VisuallyHidden>{column.header}</VisuallyHidden>
              ) : (
                column.header
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={getRowKey(row)} className={styles.row}>
            {columns.map((column) => (
              <td
                key={column.key}
                className={styles.cell}
                // Repeats the header beside the value once the table stacks.
                data-label={column.isHeaderHidden === true ? undefined : column.header}
                data-narrow={column.isNarrow ? 'true' : undefined}
              >
                {column.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Row placeholders for a loading table. Reuses `DataTable` itself with the same
 * columns, so the skeleton cannot drift out of sync with the real column set —
 * every column, width and breakpoint is shared by construction.
 */
export function DataTableSkeleton<Row>({
  caption,
  columns,
  rowCount,
}: {
  caption: string;
  columns: readonly DataTableColumn<Row>[];
  /** Match the page size the real list requests, so the swap does not shift. */
  rowCount: number;
}) {
  const placeholderColumns: DataTableColumn<number>[] = columns.map((column) => ({
    key: column.key,
    header: column.header,
    isHeaderHidden: column.isHeaderHidden,
    isNarrow: column.isNarrow,
    render: () => <SkeletonLine width={column.isNarrow === true ? '3rem' : '70%'} />,
  }));

  return (
    <div aria-hidden="true">
      <DataTable
        caption={caption}
        columns={placeholderColumns}
        rows={Array.from({ length: rowCount }, (_unused, index) => index)}
        getRowKey={(index) => String(index)}
      />
    </div>
  );
}
