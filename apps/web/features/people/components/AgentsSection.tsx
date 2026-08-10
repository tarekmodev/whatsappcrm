'use client';

import { useState } from 'react';
import type { TeamResponse, UserResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { SectionCard } from '@/components/ui/SectionCard';
import { useContent } from '@/lib/content';
import { AgentsTable, AgentsTableSkeleton } from './AgentsTable';
import { LazyInviteAgentDialog } from './agent-dialogs.lazy';

/**
 * The agents section: the card, the invite trigger and the table. Usage:
 * `<AgentsSection users={users} teams={teams} canInvite canEdit canRemove />`.
 *
 * The `can*` flags come from the server's permission check, so a role that cannot
 * invite is never rendered a button that leads to a refusal.
 */

export interface AgentsSectionProps {
  users: readonly UserResponse[];
  teams: readonly TeamResponse[];
  canInvite: boolean;
  canEdit: boolean;
  canRemove: boolean;
}

export function AgentsSection({ users, teams, canInvite, canEdit, canRemove }: AgentsSectionProps) {
  const content = useContent();
  const [isInviting, setIsInviting] = useState(false);

  return (
    <SectionCard
      id="agents"
      title={content.people.agentsHeading}
      description={content.people.agentsSectionDescription(users.length)}
      action={
        canInvite ? (
          <Button
            variant="primary"
            onClick={() => {
              setIsInviting(true);
            }}
          >
            {content.people.inviteAgent}
          </Button>
        ) : undefined
      }
    >
      <AgentsTable users={users} teams={teams} canEdit={canEdit} canRemove={canRemove} />

      {isInviting ? (
        <LazyInviteAgentDialog
          teams={teams}
          onClose={() => {
            setIsInviting(false);
          }}
        />
      ) : null}
    </SectionCard>
  );
}

/** Mirrors `AgentsSection`'s frame, with the table's own skeleton inside it. */
export function AgentsSectionSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  const content = useContent();

  return (
    <SectionCard id="agents" title={content.people.agentsHeading}>
      <AgentsTableSkeleton hasActions={hasActions} />
    </SectionCard>
  );
}
