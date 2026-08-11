'use server';

import {
  InviteCreateInputSchema,
  TeamCreateInputSchema,
  TeamUpdateInputSchema,
  UserUpdateInputSchema,
  isRoleWithin,
} from '@whatsappcrm/contracts';
import { inviteUser, removeUser, updateUser } from '@/lib/api/users';
import { createTeam, updateTeam } from '@/lib/api/teams';
import { assertPermission, verifySession } from '@/lib/session/session';
import { routes } from '@/lib/routes';
import { content } from '@/content/en';
import type { ActionResult } from '@/lib/actions/result';
import { ActionRefusedError, runAction } from '@/lib/actions/run-action';

/**
 * Mutations for the People surface. Each one asserts its permission, validates
 * against the contract's own schema and returns a discriminated result —
 * `runAction` owns that sequence; what is left here is the two role-assignment
 * invariants the permission matrix cannot express.
 */

/** Path only — `routes.settingsPeople()` may carry filter query parameters. */
const PEOPLE_PATH = routes.settingsPeople().split('?')[0] ?? '/settings/people';

export async function inviteAgentAction(input: unknown): Promise<ActionResult<{ email: string }>> {
  return runAction({
    permission: 'user:invite',
    parser: InviteCreateInputSchema,
    input,
    revalidate: PEOPLE_PATH,
    label: 'People',
    perform: async (parsed) => {
      // Mirrors the API's `assertMayAssign`: `user:invite` alone may invite an
      // `agent` and nothing else, or a supervisor could mint an admin.
      const session = await verifySession();
      const mayAssign = session.checker.can('user:set_role');

      if (!mayAssign && parsed.role !== 'agent') {
        throw new ActionRefusedError(content.people.roleNotAssignableError);
      }

      if (mayAssign && !isRoleWithin(parsed.role, session.principal.role)) {
        throw new ActionRefusedError(content.people.roleEscalationError);
      }

      const user = await inviteUser(parsed);

      return { email: user.email };
    },
  });
}

export async function updateAgentAction(
  userId: string,
  input: unknown,
): Promise<ActionResult<{ displayName: string }>> {
  return runAction({
    permission: 'user:update',
    parser: UserUpdateInputSchema,
    input,
    revalidate: PEOPLE_PATH,
    label: 'People',
    perform: async (parsed) => {
      // A server action is a public endpoint, so the role-assignment invariants are
      // re-checked here and not trusted from the dialog that hid the control.
      if (parsed.role !== undefined) {
        const session = await assertPermission('user:set_role');

        if (userId === session.principal.userId) {
          throw new ActionRefusedError(content.people.selfRoleChangeError);
        }

        if (!isRoleWithin(parsed.role, session.principal.role)) {
          throw new ActionRefusedError(content.people.roleEscalationError);
        }
      }

      const user = await updateUser(userId, parsed);

      return { displayName: user.displayName };
    },
  });
}

export async function removeAgentAction(
  userId: string,
  displayName: string,
): Promise<ActionResult<{ displayName: string }>> {
  return runAction({
    permission: 'user:remove',
    parser: null,
    input: undefined,
    revalidate: PEOPLE_PATH,
    label: 'People',
    perform: async () => {
      await removeUser(userId);

      return { displayName };
    },
  });
}

export async function createTeamAction(input: unknown): Promise<ActionResult<{ name: string }>> {
  return runAction({
    permission: 'team:write',
    parser: TeamCreateInputSchema,
    input,
    revalidate: PEOPLE_PATH,
    label: 'People',
    perform: async (parsed) => {
      const team = await createTeam(parsed);

      return { name: team.name };
    },
  });
}

export async function updateTeamMembersAction(
  teamId: string,
  input: unknown,
): Promise<ActionResult<{ name: string }>> {
  return runAction({
    permission: 'team:write',
    parser: TeamUpdateInputSchema,
    input,
    revalidate: PEOPLE_PATH,
    label: 'People',
    perform: async (parsed) => {
      const team = await updateTeam(teamId, parsed);

      return { name: team.name };
    },
  });
}
