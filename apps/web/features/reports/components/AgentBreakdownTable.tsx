import type { AgentReportRow } from '@whatsappcrm/contracts';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { DataTable, DataTableSkeleton, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { content } from '@/content/en';
import { AGENT_ROWS_SKELETON_COUNT } from '@/features/reports/constants';
import { sortAgentRows, type AgentSort } from '@/features/reports/agent-sort';
import { agentRowLabel, formatCount } from '@/features/reports/presentation';
import type { ReportParams } from '@/features/reports/report-params';
import { agentColumnMeta, type AgentColumnContext } from './agent-columns';
import { MeasuredDuration } from './MeasuredDuration';
import styles from './AgentBreakdownTable.module.css';

/**
 * The per-agent breakdown. Usage:
 * `<AgentBreakdownTable rows={metrics.agents} params={query} sort={sort} />`.
 *
 * A server component, and reusing `DataTable` rather than a chart is the whole
 * decision: the values are medians and counts per person, and a bar chart of
 * medians invites the two readings that are wrong — that the bars sum, and that a
 * short bar over two tickets means the same as a short bar over two hundred. A
 * table puts the sample beside the figure and re-flows into stacked cards below
 * the layout breakpoint, so it works at 320px without a horizontal scroller.
 *
 * **The API's order is the default, and the only order the export knows.** Rows
 * arrive ranked, with the unattributed row last by construction, and that is what
 * a supervisor sees until they ask for something else. An explicit sort is theirs:
 * it lives in the URL, so it survives a refresh and can be sent to somebody, and
 * it deliberately does not travel to the export — the CSV is the range and the
 * scope on screen, and a spreadsheet sorts itself.
 */

export interface AgentBreakdownTableProps {
  rows: readonly AgentReportRow[];
  /** The applied range and scope, so a sort link changes only the order. */
  params: ReportParams;
  /** The order in force, or `undefined` for the API's own. */
  sort?: AgentSort;
}

export function AgentBreakdownTable({ rows, params, sort }: AgentBreakdownTableProps) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon="reports"
        title={content.reports.agentsEmptyHeading}
        description={content.reports.agentsEmptyBody}
      />
    );
  }

  const columns: DataTableColumn<AgentReportRow>[] = agentColumnMeta(content, {
    params,
    sort,
  }).map((meta) => ({
    ...meta,
    render: (row) => renderCell(meta.key, row),
  }));

  return (
    <DataTable
      caption={content.reports.agentsHeading}
      columns={columns}
      rows={sortAgentRows(rows, sort)}
      getRowKey={(row) => row.userId ?? UNATTRIBUTED_ROW_KEY}
    />
  );
}

/** The one row that has no user id, and so cannot key on one. */
const UNATTRIBUTED_ROW_KEY = 'unattributed';

function renderCell(key: string, row: AgentReportRow) {
  switch (key) {
    case 'agent':
      return (
        <span className={styles.agent}>
          <span className={styles.identity}>
            {/* Decorative, and only for a person: the unattributed row is work
                with no owner, and giving it an initial would invent one. */}
            {row.userId === null ? null : (
              <Avatar name={agentRowLabel(row, content)} size="xs" tone="neutral" />
            )}
            <span className={styles.name}>{agentRowLabel(row, content)}</span>
          </span>
          {row.userId === null ? (
            <span className={styles.note}>{content.reports.unattributedHint}</span>
          ) : null}
          {row.userId !== null && !row.isActive ? (
            // A departed contractor's numbers stay in a closed period rather than
            // vanishing from it, so the row has to say why they are still here.
            <Badge tone="neutral">{content.reports.inactiveAgent}</Badge>
          ) : null}
        </span>
      );
    case 'resolved':
      return formatCount(row.ticketsResolved, content);
    case 'firstResponse':
      return <MeasuredDuration seconds={row.firstResponse.medianSeconds} />;
    case 'resolution':
      return <MeasuredDuration seconds={row.resolution.medianSeconds} />;
    default:
      return null;
  }
}

/**
 * Mirrors the loaded table exactly — it *is* the same table, with the same
 * columns, the same alignment and the same sort controls — so the swap to real
 * rows shifts nothing. `DataTable`'s `isPlaceholder` renders those controls as
 * text rather than as links, because the placeholder table is `aria-hidden` and a
 * link inside that is a tab stop nobody can see.
 *
 * The row count matches a tenant's active membership rather than a page size:
 * this table is not paginated, and "about as many rows as a team has people" is
 * the honest guess.
 */
export function AgentBreakdownTableSkeleton({ params, sort }: AgentColumnContext) {
  return (
    <>
      <LoadingAnnouncement label={content.reports.agentsLoading} />
      <DataTableSkeleton
        caption={content.reports.agentsHeading}
        rowCount={AGENT_ROWS_SKELETON_COUNT}
        columns={agentColumnMeta(content, { params, sort }).map((meta) => ({
          ...meta,
          render: () => null,
        }))}
      />
    </>
  );
}
