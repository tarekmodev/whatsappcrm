'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import {
  InviteCreateInputSchema,
  TeamCreateInputSchema,
  TeamUpdateInputSchema,
  UserUpdateInputSchema,
  isRoleWithin,
  type Permission,
} from '@whatsappcrm/contracts';
import { ApiRequestError } from '@/lib/api/http';
import { inviteUser, removeUser, updateUser } from '@/lib/api/users';
import { createTeam, updateTeam } from '@/lib/api/teams';
import { assertPermission, verifySession } from '@/lib/session/session';
import { routes } from '@/lib/routes';
import { content } from '@/content/en';
import type { ActionResult } from '@/lib/actions/result';

/**
 * Mutations for the People surface. Each one:
 *
 *   1. asserts the permission TAR-39's endpoint table assigns that endpoint — a
 *      server action is a public endpoint, so navigation gating alone is not a
 *      gate;
 *   2. validates its input against the *contract's* schema, the same object the
 *      API validates with, so the two cannot disagree;
 *   3. returns a discriminated result rather than throwing, so the calling form
 *      renders an inline error and keeps the user's input.
 *
 * The permission assertion is defence in depth, not the security boundary: the
 * API refuses the same call regardless.
 */

export async function inviteAgentAction(input: unknown): Promise<ActionResult<{ email: string }>> {
  return run('user:invite', InviteCreateInputSchema, input, async (parsed) => {
    // Mirrors the API's `assertMayAssign`: `user:invite` alone may invite an
    // `agent` and nothing else, or a supervisor could mint an admin.
    const session = await verifySession();
    const mayAssign = session.checker.can('user:set_role');

    if (!mayAssign && parsed.role !== 'agent') {
      throw new RoleAssignmentRefusedError(content.people.roleNotAssignableError);
    }

    if (mayAssign && !isRoleWithin(parsed.role, session.principal.role)) {
      throw new RoleAssignmentRefusedError(content.people.roleEscalationError);
    }

    const user = await inviteUser(parsed);

    return { email: user.email };
  });
}

export async function updateAgentAction(
  userId: string,
  input: unknown,
): Promise<ActionResult<{ displayName: string }>> {
  return run('user:update', UserUpdateInputSchema, input, async (parsed) => {
    // A server action is a public endpoint, so the role-assignment invariants are
    // re-checked here and not trusted from the dialog that hid the control.
    if (parsed.role !== undefined) {
      const session = await assertPermission('user:set_role');

      if (userId === session.principal.userId) {
        throw new RoleAssignmentRefusedError(content.people.selfRoleChangeError);
      }

      if (!isRoleWithin(parsed.role, session.principal.role)) {
        throw new RoleAssignmentRefusedError(content.people.roleEscalationError);
      }
    }

    const user = await updateUser(userId, parsed);

    return { displayName: user.displayName };
  });
}

export async function removeAgentAction(
  userId: string,
  displayName: string,
): Promise<ActionResult<{ displayName: string }>> {
  return run('user:remove', null, undefined, async () => {
    await removeUser(userId);

    return { displayName };
  });
}

export async function createTeamAction(input: unknown): Promise<ActionResult<{ name: string }>> {
  return run('team:write', TeamCreateInputSchema, input, async (parsed) => {
    const team = await createTeam(parsed);

    return { name: team.name };
  });
}

export async function updateTeamMembersAction(
  teamId: string,
  input: unknown,
): Promise<ActionResult<{ name: string }>> {
  return run('team:write', TeamUpdateInputSchema, input, async (parsed) => {
    const team = await updateTeam(teamId, parsed);

    return { name: team.name };
  });
}

/** The subset of a contract schema this module needs; avoids a direct Zod import. */
interface InputParser<T> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
}

/**
 * `parser` is `null` for an action whose only input is the path parameter it was
 * called with — a removal has no body to validate.
 */
async function run<Input, Output>(
  permission: Permission,
  parser: InputParser<Input> | null,
  input: unknown,
  perform: (parsed: Input) => Promise<Output>,
): Promise<ActionResult<Output>> {
  try {
    await assertPermission(permission);

    if (parser === null) {
      const data = await perform(undefined as Input);

      revalidatePath(PEOPLE_PATH);

      return { status: 'success', data };
    }

    const parsed = parser.safeParse(input);

    if (!parsed.success) {
      return { status: 'error', message: content.form.genericSubmitError, requestId: null };
    }

    const data = await perform(parsed.data);

    // The People page renders on the server, so a mutation invalidates it.
    revalidatePath(PEOPLE_PATH);

    return { status: 'success', data };
  } catch (error) {
    return toErrorResult(error);
  }
}

/** Path only — `routes.settingsPeople()` may carry filter query parameters. */
const PEOPLE_PATH = routes.settingsPeople().split('?')[0] ?? '/settings/people';

/**
 * Maps a failure onto copy the user can act on. The API's own `message` is shown
 * only for a refusal the user can do something about; anything else falls back to
 * the generic line, because an internal message is not user-facing text.
 */
function toErrorResult<T>(error: unknown): ActionResult<T> {
  // First, and before anything else looks at it: the session guard answers a lost
  // session with a `redirect`, which Next implements by throwing. Caught and
  // mapped to a message, that navigation would be swallowed and the user would sit
  // on a page they are no longer signed in to, reading "we could not save that".
  // `unstable_rethrow` is the documented way to let a framework-controlled throw
  // back out of a catch that also has real failures to handle.
  unstable_rethrow(error);

  // Refused by this module's own invariant check rather than by the API. The
  // message is already content-layer copy, so it is shown as-is.
  if (error instanceof RoleAssignmentRefusedError) {
    return { status: 'error', message: error.message, requestId: null };
  }

  if (error instanceof ApiRequestError) {
    return {
      status: 'error',
      message: ACTIONABLE_ERROR_CODES.has(error.code)
        ? error.message
        : content.form.genericSubmitError,
      requestId: error.requestId,
    };
  }

  // Never swallowed: the server log keeps the detail the user must not see.
  console.error('People action failed', error);

  return { status: 'error', message: content.form.genericSubmitError, requestId: null };
}

const ACTIONABLE_ERROR_CODES = new Set([
  'conflict',
  'validation_failed',
  'plan_limit_exceeded',
  'forbidden',
]);

/**
 * A role assignment this action refuses before it reaches the API, carrying copy
 * the form can render inline. Thrown rather than returned so it joins the same
 * error path as an `ApiRequestError` and cannot be forgotten by a caller.
 */
class RoleAssignmentRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleAssignmentRefusedError';
  }
}
