'use server';

import {
  CannedResponseCreateInputSchema,
  CannedResponseUpdateInputSchema,
} from '@whatsappcrm/contracts';
import {
  createCannedResponse,
  deleteCannedResponse,
  updateCannedResponse,
} from '@/lib/api/canned-responses';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { runAction } from '@/lib/actions/run-action';

/**
 * Mutations for the tenant's shared canned-response library (TAR-31, 0011).
 *
 * All three assert **`canned_response:write`**, which 0004 grants
 * supervisor-and-above and which every one of the three endpoints requires.
 * Asserting it here is defence in depth — a server action is a public endpoint,
 * and a nav entry that was never rendered is not a gate — not the security
 * boundary, which is the API's.
 *
 * Every one revalidates the settings path only. The composer's copy of the
 * library is refreshed by the realtime `canned_response.saved` and
 * `canned_response.deleted` events the API publishes to
 * `tenantCannedResponseRoom` (TAR-485/486), which is what makes TAR-31's second
 * acceptance criterion true for an agent who is not on this page — a
 * `revalidatePath` here could never reach their browser.
 */

const SAVED_REPLIES_PATH = routes.settingsSavedReplies();

export async function createCannedResponseAction(
  input: unknown,
): Promise<ActionResult<{ title: string }>> {
  return runAction({
    permission: 'canned_response:write',
    parser: CannedResponseCreateInputSchema,
    input,
    revalidate: SAVED_REPLIES_PATH,
    label: 'Saved replies',
    perform: async (parsed) => {
      const created = await createCannedResponse(parsed);

      return { title: created.title };
    },
  });
}

/**
 * Every field is editable, unlike a custom field's key: a shortcut is what an
 * agent types rather than what a stored value is filed under. Only what changed
 * is sent, because `CannedResponseUpdateInputSchema` is the create input
 * partial and a blanket write would clobber a colleague's concurrent edit to the
 * half this dialog did not touch.
 */
export async function updateCannedResponseAction(
  cannedResponseId: string,
  input: unknown,
): Promise<ActionResult<{ title: string }>> {
  return runAction({
    permission: 'canned_response:write',
    parser: CannedResponseUpdateInputSchema,
    input,
    revalidate: SAVED_REPLIES_PATH,
    label: 'Saved replies',
    perform: async (parsed) => {
      const updated = await updateCannedResponse(cannedResponseId, parsed);

      return { title: updated.title };
    },
  });
}

/**
 * Irreversible, which is why the dialog behind this names what stops working
 * rather than asking "are you sure". Nothing already sent is touched — the body
 * was copied into the message when the agent inserted it — so what is lost is
 * the shortcut, and every agent's ability to expand it.
 *
 * `title` is passed in rather than read back: a `204` carries no body, and the
 * toast has to name the reply that is now gone.
 */
export async function deleteCannedResponseAction(
  cannedResponseId: string,
  title: string,
): Promise<ActionResult<{ title: string }>> {
  return runAction({
    permission: 'canned_response:write',
    parser: null,
    input: undefined,
    revalidate: SAVED_REPLIES_PATH,
    label: 'Saved replies',
    perform: async () => {
      await deleteCannedResponse(cannedResponseId);

      return { title };
    },
  });
}
