import type { DataTableColumn } from '@/components/ui/DataTable';
import type { Content } from '@/lib/content';
import type { FlaggedTicketRow } from '../flagged-rows';

/**
 * Column metadata for the flagged-ticket queue, without the cell renderers, so
 * the table and its skeleton build from one array and cannot drift apart.
 *
 * `hasRowActions` drops the actions column entirely rather than rendering an
 * empty one, and the skeleton takes the same flag — a placeholder column that the
 * real table will not have is a layout shift with extra steps. It is `ticket:assign`
 * and nothing else: assigning is the only act this queue offers per row, so the
 * column and the permission are the same question (TAR-778).
 *
 * **Four columns, and that is a ceiling rather than a coincidence.** Where
 * routing *tried* to send a ticket rides inside the ticket cell instead of taking
 * a column of its own: measured at 768 and 820, a fifth column pushed the row
 * past its card, because `Badge` is `white-space: nowrap` and "No agents to route
 * to" is an unbreakable ~150px token that the table cannot shrink below. Adding
 * one back needs a re-measure in that band, not just a wide screen.
 *
 * A **second button** in the actions column is the same problem by another route,
 * and TAR-778 is the case: a column takes the width of its widest cell, so a
 * two-button cluster on the at-capacity rows pushed the `Assign` button on every
 * other row out of line with it. Anything that is not a per-row act belongs above
 * the table — see `CapacityNotice`.
 */
export function flaggedTicketColumnMeta(
  content: Content,
  hasRowActions: boolean,
): Omit<DataTableColumn<FlaggedTicketRow>, 'render'>[] {
  const columns: Omit<DataTableColumn<FlaggedTicketRow>, 'render'>[] = [
    { key: 'ticket', header: content.assignment.columnTicket },
    { key: 'reason', header: content.assignment.columnReason },
    { key: 'waiting', header: content.assignment.columnWaiting, isNarrow: true },
  ];

  if (hasRowActions) {
    columns.push({
      key: 'assign',
      header: content.assignment.columnAssign,
      isHeaderHidden: true,
      isNarrow: true,
    });
  }

  return columns;
}
