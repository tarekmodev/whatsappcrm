'use server';

import { ContactUpdateInputSchema } from '@whatsappcrm/contracts';
import { updateContact } from '@/lib/api/contacts';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { runAction } from '@/lib/actions/run-action';

/**
 * Mutations for a contact profile. Both go through `runAction`, which asserts
 * `contact:write` before anything else — a server action is a public endpoint,
 * and the card that hid the Save button is not a gate.
 *
 * Two actions rather than one `updateContactAction(patch)`, because the profile
 * has two independently-saveable cards and each needs its own pending state and
 * its own toast. Both send a **partial** body: `ContactUpdateInputSchema` is a
 * partial, and `customFields` is merged rather than replaced, so a tag change
 * cannot touch a custom value and vice versa.
 */

export async function saveContactTagsAction(
  contactId: string,
  displayName: string,
  input: unknown,
): Promise<ActionResult<{ displayName: string }>> {
  return runAction({
    permission: 'contact:write',
    parser: ContactUpdateInputSchema,
    input,
    revalidate: routes.contact(contactId),
    label: 'Contact tags',
    perform: async (parsed) => {
      await updateContact(contactId, parsed);

      return { displayName };
    },
  });
}

export async function saveContactCustomFieldsAction(
  contactId: string,
  displayName: string,
  input: unknown,
): Promise<ActionResult<{ displayName: string }>> {
  return runAction({
    permission: 'contact:write',
    parser: ContactUpdateInputSchema,
    input,
    revalidate: routes.contact(contactId),
    label: 'Contact custom fields',
    perform: async (parsed) => {
      await updateContact(contactId, parsed);

      return { displayName };
    },
  });
}
