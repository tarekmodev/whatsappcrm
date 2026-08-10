import type { Permission } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import type { PermissionChecker } from '@/lib/session/permissions';
import { loadPeople, type PeopleFilters } from '../people.data';
import { AgentsSection, AgentsSectionSkeleton } from './AgentsSection';
import { TeamsSection, TeamsSectionSkeleton } from './TeamsSection';

/**
 * Fetches the People data and composes the two sections. Usage: inside a Suspense
 * boundary on the People page, with `PeopleSectionsSkeleton` as the fallback.
 *
 * A server component, so the permission decisions and the fetch both happen on the
 * server and the client bundle carries neither.
 */

/** The permissions the sections' controls are gated on, named once. */
export const PEOPLE_PERMISSIONS = {
  invite: 'user:invite',
  editAgent: 'user:update',
  removeAgent: 'user:remove',
  writeTeam: 'team:write',
} as const satisfies Record<string, Permission>;

export async function PeopleSections({
  checker,
  filters,
}: {
  checker: PermissionChecker;
  filters: PeopleFilters;
}) {
  const { users, teams } = await loadPeople(filters);

  return (
    <Stack gap="5">
      <AgentsSection
        users={users}
        teams={teams}
        canInvite={checker.can(PEOPLE_PERMISSIONS.invite)}
        canEdit={checker.can(PEOPLE_PERMISSIONS.editAgent)}
        canRemove={checker.can(PEOPLE_PERMISSIONS.removeAgent)}
      />
      <TeamsSection
        teams={teams}
        users={users}
        canWrite={checker.can(PEOPLE_PERMISSIONS.writeTeam)}
      />
    </Stack>
  );
}

/**
 * The fallback. Composed from the same two section skeletons, in the same stack
 * with the same gap, so the page does not reflow when the data arrives.
 */
export function PeopleSectionsSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  return (
    <Stack gap="5">
      <AgentsSectionSkeleton hasActions={hasActions} />
      <TeamsSectionSkeleton hasActions={hasActions} />
    </Stack>
  );
}
