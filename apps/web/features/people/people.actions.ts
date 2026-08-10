'use server';

import { revalidatePath } from 'next/cache';
import {
  InviteCreateInputSchema,
  TeamCreateInputSchema,
  TeamUpdateInputSchema,
  UserUpdateInputSchema,
  type Permission,
} from '@whatsappcrm/contracts';
import { ApiRequestError } from '@/lib/api/http';
import { inviteUser, removeUser, updateUser } from '@/lib/api/users';
import { createTeam, updateTeam } from '@/lib/api/teams';
import { assertPermission } from '@/lib/session/session';
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
    const user = await inviteUser(parsed);

    return { email: user.email };
  });
}

export async function updateAgentAction(
  userId: string,
  input: unknown,
): Promise<ActionResult<{ displayName: string }>> {
  return run('user:update', UserUpdateInputSchema, input, async (parsed) => {
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
