import type { UserResponse } from '@whatsappcrm/contracts';
import type { DataTableColumn } from '@/components/ui/DataTable';
import type { Content } from '@/lib/content';

/**
 * Column metadata for the agents table, without the cell renderers.
 *
 * The real table and its skeleton both build from this, which is what keeps the
 * skeleton from drifting: adding a column changes one array and both stay in step.
 */

export type AgentColumnMeta = Omit<DataTableColumn<UserResponse>, 'render'>;

export function agentColumnMeta(content: Content, hasActions: boolean): AgentColumnMeta[] {
  const columns: AgentColumnMeta[] = [
    { key: 'name', header: content.people.columnName },
    { key: 'role', header: content.people.columnRole, isNarrow: true },
    { key: 'teams', header: content.people.columnTeams },
    { key: 'status', header: content.people.columnStatus, isNarrow: true },
    { key: 'availability', header: content.people.columnAvailability, isNarrow: true },
  ];

  if (hasActions) {
    columns.push({
      key: 'actions',
      header: content.people.columnActions,
      isHeaderHidden: true,
      isNarrow: true,
    });
  }

  return columns;
}
