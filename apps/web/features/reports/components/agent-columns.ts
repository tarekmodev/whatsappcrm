import type { AgentReportRow } from '@whatsappcrm/contracts';
import type { DataTableColumn } from '@/components/ui/DataTable';
import type { Content } from '@/lib/content';

/**
 * Column metadata for the per-agent breakdown, without the cell renderers.
 *
 * The real table and its skeleton both build from this, which is what keeps the
 * skeleton from drifting: adding a column changes one array and both stay in
 * step.
 *
 * The order follows the question a supervisor is asking. How much did each
 * person finish, then how quickly did they answer, then how long did it take to
 * finish. The two duration columns say `(median)` in their headers rather than
 * in a legend underneath, because the header is what a stacked mobile row repeats
 * beside each value.
 */

export type AgentColumnMeta = Omit<DataTableColumn<AgentReportRow>, 'render'>;

export function agentColumnMeta(content: Content): AgentColumnMeta[] {
  return [
    { key: 'agent', header: content.reports.columnAgent },
    { key: 'resolved', header: content.reports.columnResolved, isNarrow: true },
    { key: 'firstResponse', header: content.reports.columnFirstResponse },
    { key: 'resolution', header: content.reports.columnResolution },
  ];
}
