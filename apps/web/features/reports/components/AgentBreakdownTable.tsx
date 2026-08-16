import type { AgentReportRow } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { DataTable, DataTableSkeleton, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { content } from '@/content/en';
import { AGENT_ROWS_SKELETON_COUNT } from '@/features/reports/constants';
import { agentRowLabel, formatCount, formatDuration } from '@/features/reports/presentation';
import { agentColumnMeta } from './agent-columns';
import styles from './AgentBreakdownTable.module.css';

/**
 * The per-agent breakdown. Usage: `<AgentBreakdownTable rows={response.agents} />`.
 *
 * A server component, and reusing `DataTable` rather than a chart is the whole
 * decision: the values are medians and counts per person, and a bar chart of
 * medians invites the two readings that are wrong — that the bars sum, and that a
 * short bar over two tickets means the same as a short bar over two hundred. A
 * table puts the sample beside the figure and re-flows into stacked cards below
 * the layout breakpoint, so it works at 320px without a horizontal scroller.
 *
 * **Rows arrive in the API's order and are not re-sorted here.** The unattributed
 * row is last by construction, and a second ordering rule in the console is how a
 * table and the export of it start disagreeing about who is top.
 */
export function AgentBreakdownTable({ rows }: { rows: readonly AgentReportRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        heading={content.reports.agentsEmptyHeading}
        body={content.reports.agentsEmptyBody}
      />
    );
  }

  const columns: DataTableColumn<AgentReportRow>[] = agentColumnMeta(content).map((meta) => ({
    ...meta,
    render: (row) => renderCell(meta.key, row),
  }));

  return (
    <DataTable
      caption={content.reports.agentsHeading}
      columns={columns}
      rows={rows}
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
          <span className={styles.name}>{agentRowLabel(row, content)}</span>
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
      return <span className={styles.figure}>{formatCount(row.ticketsResolved, content)}</span>;
    case 'firstResponse':
      return (
        <span className={styles.figure}>
          {formatDuration(row.firstResponse.medianSeconds, content)}
        </span>
      );
    case 'resolution':
      return (
        <span className={styles.figure}>
          {formatDuration(row.resolution.medianSeconds, content)}
        </span>
      );
    default:
      return null;
  }
}

/**
 * Mirrors the loaded table exactly — it *is* the same table, with the same
 * columns and placeholder cells — so the swap to real rows shifts nothing.
 *
 * The row count matches a tenant's active membership rather than a page size:
 * this table is not paginated, and "about as many rows as a team has people" is
 * the honest guess.
 */
export function AgentBreakdownTableSkeleton() {
  return (
    <>
      <LoadingAnnouncement label={content.reports.agentsLoading} />
      <DataTableSkeleton
        caption={content.reports.agentsHeading}
        rowCount={AGENT_ROWS_SKELETON_COUNT}
        columns={agentColumnMeta(content).map((meta) => ({ ...meta, render: () => null }))}
      />
    </>
  );
}
