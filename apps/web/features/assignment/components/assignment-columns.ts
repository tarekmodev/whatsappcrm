import type { DataTableColumn } from '@/components/ui/DataTable';
import type { Content } from '@/lib/content';
import type { AgentLoadRow, TeamLoadRow } from '../assignment.data';

/**
 * Column metadata for the two workload tables, without the cell renderers, so each
 * table and its skeleton build from one array and cannot drift apart.
 */

export function agentLoadColumnMeta(
  content: Content,
): Omit<DataTableColumn<AgentLoadRow>, 'render'>[] {
  return [
    { key: 'agent', header: content.assignment.columnAgent },
    { key: 'role', header: content.people.columnRole, isNarrow: true },
    { key: 'availability', header: content.people.columnAvailability, isNarrow: true },
    { key: 'open', header: content.assignment.columnOpen, isNarrow: true },
    { key: 'unread', header: content.assignment.columnUnread, isNarrow: true },
  ];
}

export function teamLoadColumnMeta(
  content: Content,
): Omit<DataTableColumn<TeamLoadRow>, 'render'>[] {
  return [
    { key: 'team', header: content.assignment.columnTeam },
    { key: 'members', header: content.assignment.columnMembers, isNarrow: true },
    { key: 'open', header: content.assignment.columnOpen, isNarrow: true },
    { key: 'unread', header: content.assignment.columnUnread, isNarrow: true },
  ];
}
