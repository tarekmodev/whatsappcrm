'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { TeamResponse, UserResponse } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Cluster } from '@/components/layout/Cluster';
import { DataTable, DataTableSkeleton, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { useContent } from '@/lib/content';
import { AgentIdentity } from './AgentIdentity';
import { TeamNameList } from './TeamNameList';
import { agentColumnMeta } from './agent-columns';
import type { PeopleCaller } from '../role-assignment';
import { AGENTS_PAGE_SIZE } from '../constants';
import { AVAILABILITY_TONES, ROLE_TONES, USER_STATUS_TONES } from '../presentation';
import { LazyEditAgentDialog, LazyRemoveAgentDialog } from './agent-dialogs.lazy';
import styles from './AgentsTable.module.css';

/**
 * The agents list. Usage:
 * `<AgentsTable users={users} teams={teams} canEdit canRemove />`.
 *
 * A client component because the row actions open dialogs; the data is fetched on
 * the server and passed in, so no client-side waterfall is introduced.
 *
 * `canEdit` / `canRemove` come from the server's permission check and only decide
 * what is rendered — the server action asserts the permission again, and the API a
 * third time.
 */

export interface AgentsTableProps {
  users: readonly UserResponse[];
  teams: readonly TeamResponse[];
  canEdit: boolean;
  canRemove: boolean;
  /**
   * Who is looking: their id, role and whether they hold `user:set_role`. The edit
   * dialog needs all three, because assigning a role is narrower than `canEdit` —
   * see `role-assignment.ts`.
   */
  caller: PeopleCaller;
}

export function AgentsTable({ users, teams, canEdit, canRemove, caller }: AgentsTableProps) {
  const content = useContent();
  const [editing, setEditing] = useState<UserResponse | null>(null);
  const [removing, setRemoving] = useState<UserResponse | null>(null);
  const hasActions = canEdit || canRemove;

  // One lookup for the whole table rather than a `find` per row.
  const teamNamesById = useMemo(() => new Map(teams.map((team) => [team.id, team.name])), [teams]);

  const columns = useMemo<DataTableColumn<UserResponse>[]>(() => {
    const renderers: Record<string, (user: UserResponse) => ReactNode> = {
      name: (user) => <AgentIdentity user={user} />,
      role: (user) => <Badge tone={ROLE_TONES[user.role]}>{content.roles[user.role]}</Badge>,
      teams: (user) => (
        <TeamNameList
          teamNames={user.teamIds
            .map((id) => teamNamesById.get(id))
            .filter((name): name is string => name !== undefined)}
        />
      ),
      status: (user) => (
        <Badge tone={USER_STATUS_TONES[user.status]}>{content.userStatuses[user.status]}</Badge>
      ),
      availability: (user) => (
        <Badge tone={AVAILABILITY_TONES[user.availability]}>
          {content.availability[user.availability]}
        </Badge>
      ),
      // Real buttons, always visible: a hover-only row action is unreachable by
      // touch and by keyboard.
      actions: (user) => (
        <Cluster gap="1" justify="end" className={styles.actions}>
          {canEdit ? (
            <Button
              size="sm"
              variant="secondary"
              aria-label={content.people.editAgentAria(user.displayName)}
              onClick={() => {
                setEditing(user);
              }}
            >
              {content.people.editAgent}
            </Button>
          ) : null}
          {canRemove ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label={content.people.removeAgentAria(user.displayName)}
              onClick={() => {
                setRemoving(user);
              }}
            >
              {content.people.removeAgent}
            </Button>
          ) : null}
        </Cluster>
      ),
    };

    return agentColumnMeta(content, hasActions).map((meta) => ({
      ...meta,
      render: renderers[meta.key] ?? (() => null),
    }));
  }, [canEdit, canRemove, content, hasActions, teamNamesById]);

  if (users.length === 0) {
    return (
      <EmptyState
        heading={content.people.agentsEmptyHeading}
        body={content.people.agentsEmptyBody}
      />
    );
  }

  return (
    <>
      <DataTable
        caption={content.people.agentsHeading}
        columns={columns}
        rows={users}
        getRowKey={(user) => user.id}
      />

      {/* Dialog chunks load on first open, not on page load. */}
      {editing === null ? null : (
        <LazyEditAgentDialog
          user={editing}
          teams={teams}
          caller={caller}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
      {removing === null ? null : (
        <LazyRemoveAgentDialog
          user={removing}
          onClose={() => {
            setRemoving(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Mirrors the loaded table exactly — it *is* the same table, with the same
 * columns and placeholder cells — so the swap to real data shifts nothing. Row
 * count matches the page size the server requests.
 */
export function AgentsTableSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.people.agentsLoading} />
      <DataTableSkeleton
        caption={content.people.agentsHeading}
        rowCount={AGENTS_PAGE_SIZE}
        columns={agentColumnMeta(content, hasActions).map((meta) => ({
          ...meta,
          render: () => null,
        }))}
      />
    </>
  );
}
