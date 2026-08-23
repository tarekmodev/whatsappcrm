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
  /**
   * Path re-rendered on success. Paths only; a query string is not a route.
   *
   * `null` for an action that only *reads* — the composer's template picker
   * fetches on open, from a client component with no server render of its own to
   * hang the read off. It is still an action, and still wants the assert,
   * validate and error-mapping sequence; it simply has nothing to invalidate,
   * and revalidating the route it was called from would re-render the whole
   * inbox behind an open dialog for no reason.
   */
  revalidate: string | null;
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
    if (revalidate !== null) {
      revalidatePath(revalidate);
    }

    return { status: 'success', data };
  } catch (error) {
    return toActionErrorResult(error, label);
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
 *
 * Exported for `run-admin-action.ts`, which has the same three-line contract to
 * honour — rethrow a framework navigation, show an actionable refusal, log
 * everything else — behind a different gate. Two copies of this mapping is how
 * one of them ends up swallowing a `redirect`.
 */
export function toActionErrorResult<T>(
  error: unknown,
  label: string,
  /**
   * Codes whose API message this caller shows verbatim **in addition** to the
   * shared set below. Empty for every tenant surface: the list is the same for
   * all of them, and a per-caller exception is how one screen starts showing a
   * sentence written for somebody else.
   *
   * The platform-operator console passes some, because its reader is the person
   * who runs the platform rather than a customer — see `run-admin-action.ts`.
   */
  extraActionableCodes: ReadonlySet<string> = EMPTY_CODES,
): ActionResult<T> {
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
      message:
        ACTIONABLE_ERROR_CODES.has(error.code) || extraActionableCodes.has(error.code)
          ? error.message
          : content.form.genericSubmitError,
      requestId: error.requestId,
      // Carried whatever the message became. A caller that offers a different
      // affordance for a specific refusal — the seat cap's upgrade link — has to
      // branch on the code rather than on server-owned copy.
      code: error.code,
    };
  }

  // Never swallowed: the server log keeps the detail the user must not see.
  console.error(`${label} action failed`, error);

  return { status: 'error', message: content.form.genericSubmitError, requestId: null };
}

/**
 * Codes whose API message is shown to the user verbatim, because it names
 * something they can do something about. Everything else gets the generic line —
 * an internal message is not user-facing text.
 *
 * The two WhatsApp entries earn their place the same way: `whatsapp_window_expired`
 * means "that thread has gone quiet for 24 hours, send a template instead" and
 * `whatsapp_template_invalid` names the template or the variable that does not
 * match what Meta approved. Flattened into "we could not save that", both would
 * leave an agent re-pressing Send on a message that can never go.
 *
 * `workflow_reference_broken` is here for exactly that reason (TAR-27). 0009
 * introduces it as the **one** new code in the story, and its whole
 * justification for existing rather than reusing `validation_failed` is that the
 * next action differs — "pick a replacement", not "fix what you just typed".
 * Showing the generic line instead would remove the only thing it was added
 * for, and leave a supervisor re-pressing Enable on a workflow that names a tag
 * somebody deleted last week.
 */
const ACTIONABLE_ERROR_CODES = new Set([
  'conflict',
  'validation_failed',
  'plan_limit_exceeded',
  'forbidden',
  'whatsapp_window_expired',
  'whatsapp_template_invalid',
  'workflow_reference_broken',
]);

/** Shared, so the default argument allocates nothing per call. */
const EMPTY_CODES: ReadonlySet<string> = new Set<string>();
