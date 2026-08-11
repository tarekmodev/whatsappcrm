import type { Permission, SessionPrincipal } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import type { PermissionChecker } from '@/lib/session/permissions';
import { loadPeople, type PeopleFilters } from '../people.data';
import { AgentsSection, AgentsSectionSkeleton } from './AgentsSection';
import type { PeopleCaller } from '../role-assignment';
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
  /**
   * Deliberately separate from `editAgent`. TAR-79 split assigning a role out of
   * `user:update` so a supervisor holding the latter cannot promote themselves,
   * and the console has to honour the split or it offers a control the API refuses.
   */
  setRole: 'user:set_role',
  removeAgent: 'user:remove',
  writeTeam: 'team:write',
} as const satisfies Record<string, Permission>;

export async function PeopleSections({
  principal,
  checker,
  filters,
}: {
  principal: SessionPrincipal;
  checker: PermissionChecker;
  filters: PeopleFilters;
}) {
  const { users, teams } = await loadPeople(filters);
  const caller: PeopleCaller = {
    userId: principal.userId,
    role: principal.role,
    canSetRole: checker.can(PEOPLE_PERMISSIONS.setRole),
  };

  return (
    <Stack gap="5">
      <AgentsSection
        users={users}
        teams={teams}
        canInvite={checker.can(PEOPLE_PERMISSIONS.invite)}
        canEdit={checker.can(PEOPLE_PERMISSIONS.editAgent)}
        canRemove={checker.can(PEOPLE_PERMISSIONS.removeAgent)}
        caller={caller}
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
