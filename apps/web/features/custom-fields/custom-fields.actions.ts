'use server';

import {
  CustomFieldDefinitionCreateInputSchema,
  CustomFieldDefinitionUpdateInputSchema,
} from '@whatsappcrm/contracts';
import {
  createCustomFieldDefinition,
  deleteCustomFieldDefinition,
  updateCustomFieldDefinition,
} from '@/lib/api/contact-schema';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { runAction } from '@/lib/actions/run-action';

/**
 * Mutations for the tenant's contact schema — 0002 amendment 10.
 *
 * All three assert **`tenant:settings`**, not `contact:write`. Every agent holds
 * `contact:write` so that they can fill a field in; defining the shape of the
 * tenant's contact record is admin-only tenant configuration, and the API refuses
 * the call on the same rule. `runAction` asserting it here is defence in depth —
 * a server action is a public endpoint, and the nav entry that was never rendered
 * is not a gate.
 */

const CUSTOM_FIELDS_PATH = routes.settingsCustomFields();

export async function createCustomFieldAction(
  input: unknown,
): Promise<ActionResult<{ label: string }>> {
  return runAction({
    permission: 'tenant:settings',
    parser: CustomFieldDefinitionCreateInputSchema,
    input,
    revalidate: CUSTOM_FIELDS_PATH,
    label: 'Custom fields',
    perform: async (parsed) => {
      const definition = await createCustomFieldDefinition(parsed);

      return { label: definition.label };
    },
  });
}

/**
 * `label` and `options` only. `key` and `type` are immutable after creation, and
 * `CustomFieldDefinitionUpdateInputSchema` is what refuses a body carrying
 * either — so a dialog that offered them would fail here rather than silently
 * dropping them.
 */
export async function updateCustomFieldAction(
  definitionId: string,
  input: unknown,
): Promise<ActionResult<{ label: string }>> {
  return runAction({
    permission: 'tenant:settings',
    parser: CustomFieldDefinitionUpdateInputSchema,
    input,
    revalidate: CUSTOM_FIELDS_PATH,
    label: 'Custom fields',
    perform: async (parsed) => {
      const definition = await updateCustomFieldDefinition(definitionId, parsed);

      return { label: definition.label };
    },
  });
}

/**
 * Deletes the definition **and** strips its key from every contact in the
 * tenant, in one transaction. Irreversible, which is why the dialog behind this
 * names exactly what is lost rather than asking "are you sure".
 *
 * The API refuses with `conflict` when a routing rule names the key, and
 * `conflict` is in `ACTIONABLE_ERROR_CODES` — so the admin reads which rules are
 * in the way rather than the generic line.
 */
export async function deleteCustomFieldAction(
  definitionId: string,
  label: string,
): Promise<ActionResult<{ label: string }>> {
  return runAction({
    permission: 'tenant:settings',
    parser: null,
    input: undefined,
    revalidate: CUSTOM_FIELDS_PATH,
    label: 'Custom fields',
    perform: async () => {
      await deleteCustomFieldDefinition(definitionId);

      return { label };
    },
  });
}
