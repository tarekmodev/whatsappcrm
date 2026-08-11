import 'server-only';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import type { Permission } from '@whatsappcrm/contracts';
import { ApiRequestError } from '@/lib/api/http';
import { assertPermission } from '@/lib/session/session';
import { content } from '@/content/en';
import type { ActionResult } from '@/lib/actions/result';

/**
 * The body every server action in the app shares: assert, validate, perform,
 * revalidate, and turn a failure into copy the user can act on.
 *
 * Extracted when the inbox needed the identical sequence the People surface had
 * already written. The three things it exists to stop anyone getting wrong a
 * second time:
 *
 *   1. **A server action is a public endpoint.** Navigation gating is not a
 *      gate, so the permission TAR-39's endpoint table assigns is asserted here
 *      whatever the UI showed. Defence in depth, not the security boundary — the
 *      API refuses the same call regardless.
 *   2. **Input is validated against the *contract's* schema**, the same object
 *      the API validates with, so the two cannot disagree.
 *   3. **Failures come back as a value, never a throw.** A thrown server action
 *      unmounts into the route's error boundary and takes the user's half-typed
 *      form with it.
 */

/** The subset of a contract schema this module needs; avoids a direct Zod import. */
export interface InputParser<T> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
}

export interface RunActionOptions<Input, Output> {
  permission: Permission;
  /**
   * `null` for an action whose only input is the identifier it was called with —
   * a claim or a removal has no body to validate.
   */
  parser: InputParser<Input> | null;
  input: unknown;
  perform: (parsed: Input) => Promise<Output>;
  /** Path re-rendered on success. Paths only; a query string is not a route. */
  revalidate: string;
  /** Names the surface in the server log line for an unexpected failure. */
  label: string;
}

export async function runAction<Input, Output>({
  permission,
  parser,
  input,
  perform,
  revalidate,
  label,
}: RunActionOptions<Input, Output>): Promise<ActionResult<Output>> {
  try {
    await assertPermission(permission);

    const parsed =
      parser === null
        ? { success: true as const, data: undefined as Input }
        : parser.safeParse(input);

    if (!parsed.success) {
      return { status: 'error', message: content.form.genericSubmitError, requestId: null };
    }

    const data = await perform(parsed.data);

    // These surfaces render on the server, so a mutation invalidates them.
    revalidatePath(revalidate);

    return { status: 'success', data };
  } catch (error) {
    return toErrorResult(error, label);
  }
}

/**
 * A refusal the action makes itself, carrying copy from the content layer.
 *
 * Thrown rather than returned so it joins the same error path as an
 * `ApiRequestError` and cannot be forgotten by a caller.
 */
export class ActionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionRefusedError';
  }
}

/**
 * Maps a failure onto copy the user can act on. The API's own `message` is shown
 * only for a refusal the user can do something about; anything else falls back to
 * the generic line, because an internal message is not user-facing text.
 */
function toErrorResult<T>(error: unknown, label: string): ActionResult<T> {
  // First, and before anything else looks at it: the session guard answers a lost
  // session with a `redirect`, which Next implements by throwing. Caught and
  // mapped to a message, that navigation would be swallowed and the user would sit
  // on a page they are no longer signed in to, reading "we could not save that".
  // `unstable_rethrow` is the documented way to let a framework-controlled throw
  // back out of a catch that also has real failures to handle.
  unstable_rethrow(error);

  if (error instanceof ActionRefusedError) {
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
  console.error(`${label} action failed`, error);

  return { status: 'error', message: content.form.genericSubmitError, requestId: null };
}

const ACTIONABLE_ERROR_CODES = new Set([
  'conflict',
  'validation_failed',
  'plan_limit_exceeded',
  'forbidden',
]);
