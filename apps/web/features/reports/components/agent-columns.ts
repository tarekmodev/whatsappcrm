import type { AgentReportRow } from '@whatsappcrm/contracts';
import type { DataTableColumn, DataTableSort } from '@/components/ui/DataTable';
import type { Content } from '@/lib/content';
import { routes } from '@/lib/routes';
import { nextSortFor, type AgentSort, type AgentSortColumn } from '@/features/reports/agent-sort';
import type { ReportParams } from '@/features/reports/report-params';

/**
 * Column metadata for the per-agent breakdown, without the cell renderers.
 *
 * The real table and its skeleton both build from this, which is what keeps the
 * skeleton from drifting: adding a column changes one array and both stay in
 * step, including its alignment and its sort control's width.
 *
 * The order follows the question a supervisor is asking. How much did each
 * person finish, then how quickly did they answer, then how long did it take to
 * finish. The two duration columns say `(median)` in their headers rather than
 * in a legend underneath, because the header is what a stacked mobile row repeats
 * beside each value.
 */

export type AgentColumnMeta = Omit<DataTableColumn<AgentReportRow>, 'render'>;

export interface AgentColumnContext {
  /** The applied range and scope, so a sort link changes only the order. */
  params: ReportParams;
  /** The order in force. Omitted for the API's own. */
  sort?: AgentSort;
}

export function agentColumnMeta(content: Content, context: AgentColumnContext): AgentColumnMeta[] {
  return [
    { key: 'agent', header: content.reports.columnAgent, sort: sortFor('agent', content, context) },
    {
      key: 'resolved',
      header: content.reports.columnResolved,
      isNarrow: true,
      isNumeric: true,
      sort: sortFor('resolved', content, context),
    },
    {
      key: 'firstResponse',
      header: content.reports.columnFirstResponse,
      isNumeric: true,
      sort: sortFor('firstResponse', content, context),
    },
    {
      key: 'resolution',
      header: content.reports.columnResolution,
      isNumeric: true,
      sort: sortFor('resolution', content, context),
    },
  ];
}

/**
 * One column's sort control: where pressing it goes, what that will do, and what
 * is true now.
 *
 * The skeleton builds the same controls from the same applied query, so the
 * header keeps its width across the swap — `DataTable`'s `isPlaceholder` is what
 * stops them being links while the table is `aria-hidden`.
 */
function sortFor(
  column: AgentSortColumn,
  content: Content,
  context: AgentColumnContext,
): DataTableSort {
  const next = nextSortFor(column, context.sort);
  const header = headerFor(column, content);

  return {
    href: routes.reports({
      from: context.params.from,
      to: context.params.to,
      scope: context.params.scope,
      sort: next.column,
      sortDirection: next.direction,
    }),
    // Says what activating it will do. `aria-sort` already reports what is true
    // now, and a label repeating that would leave a keyboard user guessing which
    // way the next press goes.
    label:
      next.direction === 'asc'
        ? content.reports.sortAscending(header)
        : content.reports.sortDescending(header),
    direction: appliedDirection(column, context.sort),
  };
}

function appliedDirection(
  column: AgentSortColumn,
  sort: AgentSort | undefined,
): DataTableSort['direction'] {
  if (sort?.column !== column) {
    return undefined;
  }

  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

function headerFor(column: AgentSortColumn, content: Content): string {
  switch (column) {
    case 'agent':
      return content.reports.columnAgent;
    case 'resolved':
      return content.reports.columnResolved;
    case 'firstResponse':
      return content.reports.columnFirstResponse;
    case 'resolution':
      return content.reports.columnResolution;
  }
}
