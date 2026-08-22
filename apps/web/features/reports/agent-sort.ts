import type { AgentReportRow } from '@whatsappcrm/contracts';

/**
 * How the per-agent breakdown is ordered, and by what.
 *
 * **The API's order is still the default**, and that matters: the export is
 * serialised from the same response in the same order, so an unsorted table and
 * the CSV of it are the same list. What TAR-519 adds is an order the *supervisor*
 * chose — "who is slowest to first reply" is the question the table is usually
 * opened for, and reading four rows to answer it is a table doing half its job.
 *
 * It lives in the URL rather than in component state, so the sorted view survives
 * a refresh and can be sent to somebody. The export is deliberately unaffected:
 * it exports the range and the scope on screen, and a spreadsheet sorts itself.
 */

export const AGENT_SORT_COLUMNS = ['agent', 'resolved', 'firstResponse', 'resolution'] as const;
export type AgentSortColumn = (typeof AGENT_SORT_COLUMNS)[number];

export const AGENT_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type AgentSortDirection = (typeof AGENT_SORT_DIRECTIONS)[number];

export interface AgentSort {
  readonly column: AgentSortColumn;
  readonly direction: AgentSortDirection;
}

/**
 * The order a column is offered in first.
 *
 * A name reads from A; a figure reads from its largest. Somebody sorting by
 * resolution time wants the worst of it at the top — that is the reason they
 * pressed the header — and making them press it twice to get there is the
 * default being wrong rather than merely arbitrary.
 */
export function defaultDirectionFor(column: AgentSortColumn): AgentSortDirection {
  return column === 'agent' ? 'asc' : 'desc';
}

/**
 * The sort a header links to: this column in its default order, or the opposite
 * order when it is already the one in force.
 */
export function nextSortFor(column: AgentSortColumn, current: AgentSort | undefined): AgentSort {
  if (current?.column !== column) {
    return { column, direction: defaultDirectionFor(column) };
  }

  return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

/**
 * An applied sort from two untrusted query parameters, or `undefined` for the
 * API's own order.
 *
 * A hand-edited URL falls back to that default rather than throwing, which is the
 * same rule `report-params.ts` narrows the range by. A direction without a column
 * says nothing and is dropped with it.
 */
export function parseAgentSort(
  column: string | undefined,
  direction: string | undefined,
): AgentSort | undefined {
  const parsedColumn = AGENT_SORT_COLUMNS.find((candidate) => candidate === column);

  if (parsedColumn === undefined) {
    return undefined;
  }

  const parsedDirection = AGENT_SORT_DIRECTIONS.find((candidate) => candidate === direction);

  return { column: parsedColumn, direction: parsedDirection ?? defaultDirectionFor(parsedColumn) };
}

/**
 * The rows in the requested order, or exactly as they arrived when none was.
 *
 * Two rules the obvious comparator gets wrong:
 *
 *  - **An unmeasured duration sorts last in both directions.** `null` is "nobody
 *    was answered", not "answered in no time", so a row with no data must never
 *    take the top of an ascending column and be read as the fastest.
 *  - **The unattributed row keeps to the bottom.** It is not a person, and it has
 *    no name to alphabetise; floating it into the middle of a name sort would
 *    read as a colleague called "Not recorded".
 *
 * The sort is stable — `Array.prototype.sort` has been since ES2019 — so rows the
 * comparator cannot separate keep the API's order rather than shuffling between
 * renders.
 */
export function sortAgentRows(
  rows: readonly AgentReportRow[],
  sort: AgentSort | undefined,
): readonly AgentReportRow[] {
  if (sort === undefined) {
    return rows;
  }

  const sign = sort.direction === 'asc' ? 1 : -1;

  return [...rows].sort((left, right) => {
    const attribution = rank(left) - rank(right);

    if (attribution !== 0) {
      return attribution;
    }

    if (sort.column === 'agent') {
      return sign * (left.name ?? '').localeCompare(right.name ?? '');
    }

    const leftValue = figureOf(left, sort.column);
    const rightValue = figureOf(right, sort.column);

    if (leftValue === null || rightValue === null) {
      return (leftValue === null ? 1 : 0) - (rightValue === null ? 1 : 0);
    }

    return sign * (leftValue - rightValue);
  });
}

/** The unattributed row's rank, which keeps it under every named one. */
function rank(row: AgentReportRow): number {
  return row.userId === null ? 1 : 0;
}

function figureOf(row: AgentReportRow, column: Exclude<AgentSortColumn, 'agent'>): number | null {
  switch (column) {
    case 'resolved':
      return row.ticketsResolved;
    case 'firstResponse':
      return row.firstResponse.medianSeconds;
    case 'resolution':
      return row.resolution.medianSeconds;
  }
}
