'use server';

import { unstable_rethrow } from 'next/navigation';
import { toActionErrorResult } from '@/lib/actions/run-action';
import type { ActionResult } from '@/lib/actions/result';
import { content } from '~/content/en';
import { forgetCredential, storeCredential } from '~/lib/credential';
import { verifyCredential } from '~/lib/api/admin';

/**
 * The two actions that manage the credential itself.
 *
 * Neither goes through `runAdminAction`: one of them is in the business of
 * *setting* the credential that gate asserts, and the other of clearing it —
 * signing out with a token the API has already rejected is precisely what an
 * operator in that state needs to be able to do.
 *
 * Neither returns the credential, or anything derived from it. A server action's
 * return value crosses to the browser.
 */

/**
 * Takes a token, asks the API whether it is one, and stores it on success.
 *
 * The verification is the point. A console that stored whatever was typed would
 * let an operator through to a shell whose every section then failed, with the
 * screen that could have said "that credential was refused" behind them.
 *
 * A refusal is an inline message rather than a thrown failure — it is the
 * ordinary outcome of mistyping a secret. Anything that is *not* a refusal (the
 * API being unreachable) takes the error path, because telling an operator their
 * token is wrong when the API is down sends them looking in the wrong place.
 */
export async function presentCredentialAction(input: unknown): Promise<ActionResult<void>> {
  try {
    const token = typeof input === 'string' ? input.trim() : '';

    if (token.length === 0) {
      return {
        status: 'error',
        message: content.credential.tokenRequiredError,
        requestId: null,
      };
    }

    if (!(await verifyCredential(token))) {
      return { status: 'error', message: content.credential.refused, requestId: null };
    }

    await storeCredential(token);

    return { status: 'success', data: undefined };
  } catch (error) {
    unstable_rethrow(error);

    return toActionErrorResult(error, 'Present operator credential');
  }
}

/**
 * Drops it — the bar's "Forget credential" control (spec §2.2).
 *
 * There is no server-side session to end: the token is shared and outlives every
 * browser, so this is the whole of it. Rotating `PLATFORM_ADMIN_TOKEN` is what
 * revokes a credential, and `platform-admin.guard.ts` says so.
 *
 * The navigation is the caller's rather than a `redirect` here, so a one-line
 * cookie write stays testable without a router.
 */
export async function forgetCredentialAction(): Promise<ActionResult<void>> {
  await forgetCredential();

  return { status: 'success', data: undefined };
}
