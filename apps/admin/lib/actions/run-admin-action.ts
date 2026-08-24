import 'server-only';

import { revalidatePath } from 'next/cache';
import { toActionErrorResult, type InputParser } from '@/lib/actions/run-action';
import type { ActionResult } from '@/lib/actions/result';
import { CredentialRefusedError, requireCredential } from '~/lib/credential';
import { content } from '~/content/en';

/**
 * The body every operator server action shares: gate, validate, perform,
 * revalidate, and turn a failure into copy the operator can act on.
 *
 * `apps/web`'s `runAction` is its twin, and the differences are the two that
 * matter:
 *
 *   1. **The gate is a credential, not a permission.** There is no principal and
 *      no role table on this surface — the API authenticates a shared bearer
 *      token — so the assertion is "this request carries one".
 *   2. **The API's own message reaches the operator more freely.** `runAction`
 *      shows it for a short list of codes, because a tenant user must never read
 *      an internal sentence. This reader *operates the platform*: "this webhook
 *      event is processed, not parked" is the answer to what they just did, and
 *      flattening it would send them to psql to find out what they were told.
 *
 * Everything else is `runAction`'s and is imported rather than re-implemented — a
 * server action is a public endpoint whichever gate it is behind, and a framework
 * `redirect` thrown inside the `try` must still leave it.
 */

export interface RunAdminActionOptions<Input, Output> {
  /** `null` for an action whose only input is the identifier it was called with. */
  parser: InputParser<Input> | null;
  input: unknown;
  perform: (parsed: Input) => Promise<Output>;
  /**
   * Path re-rendered on success, or a function of the parsed input where the
   * path depends on what was submitted. `null` for an action that only reads.
   */
  revalidate: string | ((parsed: Input) => string) | null;
  /** Names the surface in the server log line for an unexpected failure. */
  label: string;
}

export async function runAdminAction<Input, Output>({
  parser,
  input,
  perform,
  revalidate,
  label,
}: RunAdminActionOptions<Input, Output>): Promise<ActionResult<Output>> {
  try {
    // Defence in depth, not the security boundary: a server action is a POST to
    // the route it lives on, and `proxy.ts`'s cookie check is optimistic. The API
    // refuses the same call without a valid token regardless.
    await requireCredential();

    const parsed =
      parser === null
        ? { success: true as const, data: undefined as Input }
        : parser.safeParse(input);

    if (!parsed.success) {
      return { status: 'error', message: content.errors.body, requestId: null };
    }

    const data = await perform(parsed.data);

    if (revalidate !== null) {
      revalidatePath(typeof revalidate === 'function' ? revalidate(parsed.data) : revalidate);
    }

    return { status: 'success', data };
  } catch (error) {
    /*
     * A credential refused mid-action is not a generic failure and must not read
     * as one: the token was rotated under the operator, and the sentence that
     * says so is the only one that leads anywhere.
     */
    if (error instanceof CredentialRefusedError) {
      return {
        status: 'error',
        message: content.credential.refusedMidSessionTitle,
        requestId: null,
        code: 'unauthenticated',
      };
    }

    return toActionErrorResult(error, label, OPERATOR_ACTIONABLE_ERROR_CODES);
  }
}

/**
 * Codes this surface shows the API's own message for, on top of the shared set.
 *
 * `not_found` is why the list exists: three of the operator's calls name a
 * resource the operator typed — a slug, a hostname, an event id — and "no stored
 * webhook event has that id" is the answer to "did I paste the right one".
 * `runAction` withholds it from a tenant user because a `404` on a surface they
 * navigated to is an internal detail; here it is the result.
 */
const OPERATOR_ACTIONABLE_ERROR_CODES: ReadonlySet<string> = new Set(['not_found']);
