'use server';

import { SlaPolicyUpdateInputSchema } from '@whatsappcrm/contracts';
import { updateSlaPolicy } from '@/lib/api/sla';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { runAction } from '@/lib/actions/run-action';

/**
 * Saving the workspace's response window (TAR-390).
 *
 * `sla:write`, which is the permission ADR 0006 assigns `PATCH /sla-policies/{id}`
 * — asserted here as well as on the page, because a server action is a public
 * endpoint and navigation gating is not a gate. The API refuses the same call a
 * third time regardless.
 *
 * The input is parsed with the contract's own `SlaPolicyUpdateInputSchema`, so
 * the console and the API cannot disagree about what a valid body is — including
 * the two fields the schema *omits*: `priority` and `businessHoursOnly` are
 * stripped rather than forwarded, which is what keeps this screen from
 * publishing a control the API would refuse.
 *
 * ## Why the whole form is sent, not just what changed
 *
 * `PATCH` is partial, so sending three fields where one moved is redundant on
 * the wire and correct in every other way: the alternative is a diff computed in
 * the browser against values that may already be stale, and a diff that gets it
 * wrong silently drops an edit. Replaying the same three values is idempotent by
 * construction, which is the property the endpoint was designed around.
 */
export async function updateSlaWindowAction(
  policyId: string,
  input: unknown,
): Promise<ActionResult<undefined>> {
  return runAction({
    permission: 'sla:write',
    parser: SlaPolicyUpdateInputSchema,
    input,
    revalidate: routes.settingsSla(),
    label: 'SLA window',
    perform: async (parsed) => {
      await updateSlaPolicy(policyId, parsed);

      // Nothing is returned to the caller: the form's fields already hold what
      // was just saved, and the server re-renders the page behind it.
      return undefined;
    },
  });
}
