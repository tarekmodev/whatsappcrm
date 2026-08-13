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
 *
 * **That breakpoint is a container query, not a media query**, and the wrapper
 * below is what it measures. A table's space is the viewport *minus the console's
 * navigation rail*, and the rail appears at exactly the width the table used to
 * un-stack at: on a 768px screen the table was told it had 768px and given 528,
 * so it laid out as a real table and pushed the whole page into horizontal
 * scroll. Measuring the space it actually has is the only version of this that
 * cannot be wrong, and it also makes the component correct inside a dialog or a
 * side panel, neither of which the viewport knows about.
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

/**
 * Row flags this table can draw, as a rule down the row's inline start.
 *
 * A deliberately short list — the same two the `Badge` tones mean here — because
 * a table where several rows are flagged in different colours has flagged
 * nothing. `undefined` is the ordinary row.
 */
export type DataTableRowTone = 'danger' | 'warning';

export interface DataTableProps<Row> {
  /** The table's accessible name. Visually hidden unless `isCaptionVisible`. */
  caption: string;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowKey: (row: Row) => string;
  isCaptionVisible?: boolean;
  /**
   * Draws a coloured rule down a row that needs the eye. **Decoration only**:
   * the same fact must already be readable in one of the row's own cells, or the
   * flag would be meaning conveyed by colour alone — which fails at AA and
   * disappears entirely in forced-colors mode.
   *
   * The ticket queue uses it for a breached SLA, beside a cell that says
   * "Overdue" in words.
   */
  getRowTone?: (row: Row) => DataTableRowTone | undefined;
}

export function DataTable<Row>({
  caption,
  columns,
  rows,
  getRowKey,
  isCaptionVisible = false,
  getRowTone,
}: DataTableProps<Row>) {
  return (
    <div className={styles.container}>
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
            <tr key={getRowKey(row)} className={styles.row} data-tone={getRowTone?.(row)}>
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
    </div>
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
