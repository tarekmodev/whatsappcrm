'use client';

import { useState } from 'react';
import type { TeamResponse, UserResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { SectionCard } from '@/components/ui/SectionCard';
import { useContent } from '@/lib/content';
import { TeamsList, TeamsListSkeleton } from './TeamsList';
import { LazyCreateTeamDialog } from './team-dialogs.lazy';

/**
 * The teams section: the card, the create trigger and the card grid. Usage:
 * `<TeamsSection teams={teams} users={users} canWrite />`.
 */
export function TeamsSection({
  teams,
  users,
  canWrite,
}: {
  teams: readonly TeamResponse[];
  users: readonly UserResponse[];
  canWrite: boolean;
}) {
  const content = useContent();
  const [isCreating, setIsCreating] = useState(false);

  return (
    <SectionCard
      id="teams"
      title={content.people.teamsHeading}
      description={content.people.teamsSectionDescription}
      action={
        canWrite ? (
          <Button
            variant="primary"
            onClick={() => {
              setIsCreating(true);
            }}
          >
            {content.people.createTeam}
          </Button>
        ) : undefined
      }
    >
      <TeamsList teams={teams} users={users} canManageMembers={canWrite} />

      {isCreating ? (
        <LazyCreateTeamDialog
          users={users}
          onClose={() => {
            setIsCreating(false);
          }}
        />
      ) : null}
    </SectionCard>
  );
}

/** Mirrors `TeamsSection`'s frame, with the list's own skeleton inside it. */
export function TeamsSectionSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  const content = useContent();

  return (
    <SectionCard id="teams" title={content.people.teamsHeading}>
      <TeamsListSkeleton hasActions={hasActions} />
    </SectionCard>
  );
}
