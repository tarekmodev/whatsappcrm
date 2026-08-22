'use client';

import { useMemo, useState } from 'react';
import type { TeamResponse, UserResponse } from '@whatsappcrm/contracts';
import { AutoGrid } from '@/components/layout/AutoGrid';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import { TEAMS_SKELETON_COUNT } from '../constants';
import { LazyTeamMembersDialog } from './team-dialogs.lazy';
import styles from './TeamsList.module.css';

/**
 * Teams as cards. Usage:
 * `<TeamsList teams={teams} users={users} canManageMembers />`.
 *
 * Cards rather than a table: a team has two fields and a member count, and an
 * auto-fitting grid of cards reads better than a two-column table at every width.
 */
export function TeamsList({
  teams,
  users,
  canManageMembers,
}: {
  teams: readonly TeamResponse[];
  users: readonly UserResponse[];
  canManageMembers: boolean;
}) {
  const content = useContent();
  const [managing, setManaging] = useState<TeamResponse | null>(null);

  if (teams.length === 0) {
    return (
      <EmptyState
        icon="people"
        title={content.people.teamsEmptyHeading}
        description={content.people.teamsEmptyBody}
      />
    );
  }

  return (
    <>
      <AutoGrid minItemWidth="16rem">
        {teams.map((team) => (
          <TeamCard
            key={team.id}
            team={team}
            canManageMembers={canManageMembers}
            onManageMembers={() => {
              setManaging(team);
            }}
          />
        ))}
      </AutoGrid>

      {managing === null ? null : (
        <LazyTeamMembersDialog
          team={managing}
          users={users}
          onClose={() => {
            setManaging(null);
          }}
        />
      )}
    </>
  );
}

function TeamCard({
  team,
  canManageMembers,
  onManageMembers,
}: {
  team: TeamResponse;
  canManageMembers: boolean;
  onManageMembers: () => void;
}) {
  const content = useContent();
  const memberCount = useMemo(() => team.memberUserIds.length, [team.memberUserIds]);

  return (
    <article className={styles.card}>
      <h3 className={styles.name}>{team.name}</h3>
      <p className={styles.description}>{team.description ?? content.people.teamsEmptyBody}</p>
      <p className={styles.meta}>{content.people.memberCount(memberCount)}</p>
      {canManageMembers ? (
        <Button
          size="sm"
          variant="secondary"
          isBlock
          aria-label={content.people.manageMembersAria(team.name)}
          onClick={onManageMembers}
        >
          {content.people.manageMembers}
        </Button>
      ) : null}
    </article>
  );
}

/**
 * Mirrors `TeamCard`: same grid, same card frame, same three text rows and the
 * same action-height footer, so the swap to real teams shifts nothing.
 */
export function TeamsListSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.people.teamsLoading} />
      <AutoGrid minItemWidth="16rem">
        {Array.from({ length: TEAMS_SKELETON_COUNT }, (_unused, index) => (
          <article key={index} className={styles.card} aria-hidden="true">
            <SkeletonLine width="8rem" height="1.125rem" />
            <SkeletonText lines={2} />
            <SkeletonLine width="5rem" />
            {hasActions ? <SkeletonLine height="var(--size-touch-target)" /> : null}
          </article>
        ))}
      </AutoGrid>
    </>
  );
}
