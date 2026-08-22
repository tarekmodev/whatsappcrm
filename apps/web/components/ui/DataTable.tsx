import type { ReactNode } from 'react';
import Link from 'next/link';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { Icon } from './Icon';
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

/**
 * A sortable column's control, supplied by the caller.
 *
 * A **link**, not a button: the order belongs in the URL, so a sorted table
 * survives a refresh and can be sent to somebody. The table renders the affordance
 * and reports the state through `aria-sort`; where the link goes and what the
 * order means are the caller's, because only the caller knows how its own query
 * is spelled.
 */
export interface DataTableSort {
  /** Where activating the header goes — the same view, ordered differently. */
  href: string;
  /**
   * Names the control. It must say what activating it will *do*, because
   * `aria-sort` already reports what is true now: "Sort by resolved, highest
   * first".
   */
  label: string;
  /** How the table is ordered by this column now. `undefined` if it is not. */
  direction?: 'ascending' | 'descending';
}

export interface DataTableColumn<Row> {
  /** Stable key, also the `data-label` source for the stacked card layout. */
  key: string;
  header: string;
  render: (row: Row) => ReactNode;
  /** Header is for assistive technology only — use for an actions column. */
  isHeaderHidden?: boolean;
  /** Shrinks to content instead of sharing the free space. */
  isNarrow?: boolean;
  /**
   * Aligns the column's contents to the inline end. For figures: a column of
   * numbers a reader compares by eye has to line up on its last digit, which is
   * what right alignment and tabular numerals do together.
   *
   * Ignored in the stacked card layout, where a value sits under its own label
   * and there is no column to line up with.
   */
  isNumeric?: boolean;
  /** Makes the header a sort control. Omitted on a column that cannot be sorted. */
  sort?: DataTableSort;
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
   * Renders sortable headers as plain text rather than as links. The skeleton's
   * own flag: its table is `aria-hidden`, and a link inside that is a tab stop
   * nobody can see — while dropping the affordance entirely would make the
   * placeholder header a different width from the real one.
   */
  isPlaceholder?: boolean;
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
  isPlaceholder = false,
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
                data-numeric={column.isNumeric ? 'true' : undefined}
                aria-sort={
                  column.sort === undefined ? undefined : (column.sort.direction ?? 'none')
                }
              >
                {column.isHeaderHidden === true ? (
                  <VisuallyHidden>{column.header}</VisuallyHidden>
                ) : (
                  <HeaderLabel column={column} isPlaceholder={isPlaceholder} />
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
                  data-numeric={column.isNumeric ? 'true' : undefined}
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
 * A column header, with its sort control when it has one.
 *
 * The chevron is drawn on every sortable column, muted until that column is the
 * one in force — a header that only grows an affordance on hover is one a touch
 * user never discovers, and one whose width changes when they find it.
 */
function HeaderLabel<Row>({
  column,
  isPlaceholder,
}: {
  column: DataTableColumn<Row>;
  isPlaceholder: boolean;
}) {
  const { sort } = column;

  if (sort === undefined) {
    return column.header;
  }

  const marker = (
    // `data-*` on a wrapper rather than a second class: the direction is state,
    // and the ascending arrow is the descending one flipped in the module file.
    <span
      className={styles.sortMarker}
      data-direction={sort.direction ?? 'none'}
      aria-hidden="true"
    >
      <Icon name="chevronDown" size="sm" />
    </span>
  );

  if (isPlaceholder) {
    return (
      <span className={styles.sortControl}>
        {column.header}
        {marker}
      </span>
    );
  }

  return (
    <Link href={sort.href} className={styles.sortControl} aria-label={sort.label}>
      {column.header}
      {marker}
    </Link>
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
    isNumeric: column.isNumeric,
    // Carried so the header keeps its chevron and its width; `isPlaceholder`
    // below is what stops it being a link inside an `aria-hidden` subtree.
    sort: column.sort,
    render: () => <SkeletonLine width={column.isNarrow === true ? '3rem' : '70%'} />,
  }));

  return (
    <div aria-hidden="true">
      <DataTable
        caption={caption}
        columns={placeholderColumns}
        rows={Array.from({ length: rowCount }, (_unused, index) => index)}
        getRowKey={(index) => String(index)}
        isPlaceholder
      />
    </div>
  );
}
