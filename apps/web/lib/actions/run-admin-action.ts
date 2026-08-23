import 'server-only';

import { revalidatePath } from 'next/cache';
import { requirePlatformCredential } from '@/lib/admin/platform-credential';
import { content } from '@/content/en';
import { toActionErrorResult, type InputParser } from '@/lib/actions/run-action';
import type { ActionResult } from '@/lib/actions/result';

/**
 * The body every **platform-operator** server action shares: gate, validate,
 * perform, revalidate, and turn a failure into copy the operator can act on.
 *
 * `runAction`'s twin, and the differences are exactly the two that matter:
 *
 *   1. **The gate is a credential, not a permission.** There is no principal and
 *      no role table on this surface — `PlatformAdminGuard` authenticates a
 *      shared bearer token — so the assertion is "this request carries one", and
 *      an action reached without one redirects to the credential form rather than
 *      returning an error a form would render inline.
 *   2. **`ApiRequestError` codes reach the operator more freely.** `runAction`
 *      shows the API's own message only for a short list of codes, because a
 *      tenant user must never read an internal sentence. This reader *operates
 *      the platform*: "this webhook event is processed, not parked" and "no
 *      stored webhook event has that id" are the answer to what they just did,
 *      and flattening them into "we could not save that" would send them to psql
 *      to find out what the API already told them.
 *
 * Everything else is shared with `runAction` rather than re-implemented — a
 * server action is a public endpoint whichever gate it is behind, and a
 * framework `redirect` thrown inside the `try` must still leave it.
 */

export interface RunAdminActionOptions<Input, Output> {
  /** `null` for an action whose only input is the identifier it was called with. */
  parser: InputParser<Input> | null;
  input: unknown;
  perform: (parsed: Input) => Promise<Output>;
  /**
   * Path re-rendered on success. Paths only; a query string is not a route, and
   * `null` is for an action that only reads.
   *
   * A **function** where the path depends on what was submitted — the tenant
   * screen's two actions revalidate `/admin/tenants/{slug}`, and the slug is the
   * input. It receives the *parsed* value, so the path is never built from a
   * string the parser has not accepted.
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
    await requirePlatformCredential();

    const parsed =
      parser === null
        ? { success: true as const, data: undefined as Input }
        : parser.safeParse(input);

    if (!parsed.success) {
      return { status: 'error', message: content.form.genericSubmitError, requestId: null };
    }

    const data = await perform(parsed.data);

    if (revalidate !== null) {
      revalidatePath(typeof revalidate === 'function' ? revalidate(parsed.data) : revalidate);
    }

    return { status: 'success', data };
  } catch (error) {
    return toActionErrorResult(error, label, OPERATOR_ACTIONABLE_ERROR_CODES);
  }
}

/**
 * Codes this surface shows the API's own message for, on top of the shared set.
 *
 * `not_found` is the whole reason the list exists. Three of the operator's calls
 * name a resource the operator typed — a tenant slug, a hostname, a webhook event
 * id — and "no stored webhook event has that id" is the answer to "did I paste
 * the right one". `runAction` withholds it from a tenant user because a `404` on
 * a surface they navigated to is an internal detail; here it is the result.
 */
const OPERATOR_ACTIONABLE_ERROR_CODES: ReadonlySet<string> = new Set(['not_found']);
