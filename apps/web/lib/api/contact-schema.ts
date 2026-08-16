import 'server-only';

import {
  CustomFieldDefinitionSchema,
  TagSchema,
  type CustomFieldDefinition,
  type CustomFieldDefinitionCreateInput,
  type CustomFieldDefinitionUpdateInput,
  type Tag,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';
import { ApiRequestError } from '@/lib/api/http';
import { parseCursorPage } from '@/lib/api/parse';

/**
 * The tenant's *contact vocabulary* — its tags and its custom-field definitions.
 *
 * Read by the routing-rule condition builder (TAR-289), which cannot ask a
 * supervisor to type a tag's UUID or guess a custom field's machine key. ADR 0007
 * requires exactly this: a `tag` condition carries tag ids, and a
 * `contact_attribute` condition's `key` "must name a `custom_field_defs.key` in
 * this tenant", which is what gives the console a dropdown to populate.
 *
 * ⚠️ **Both shapes are in the merged contract; neither endpoint is in TAR-39's
 * published table yet** — `ContactsModule` owns tags and custom fields, and TAR-33
 * builds their editors. This is the same gap `PATCH /v1/teams/{id}` sits in, and
 * it is handled the same way: the module names the endpoint it needs, the mock
 * transport serves it, and the omission is raised on the issue rather than worked
 * around per component.
 *
 * Until it lands for real, `not_found` — and only `not_found` — is read as "this
 * tenant has no vocabulary yet" rather than as a failure. That is not a swallowed
 * error: every other status still propagates to the section's error boundary, and
 * an empty list is a state the condition builder renders deliberately, with copy
 * explaining why the condition cannot be used.
 */

const TAGS_PATH = '/v1/tags';
const CUSTOM_FIELDS_PATH = '/v1/custom-fields';

/**
 * A vocabulary cap, not a page size: nothing that reads this paginates, and every
 * id a rule stores has to resolve back to a name. 100 is `CursorPageQuerySchema`'s
 * ceiling. `features/routing-rules/constants.ts` states the same bound for the
 * agent read — separately, because `lib/` may not import from `features/`.
 */
const VOCABULARY_LIMIT = 100;

export async function listTags(): Promise<readonly Tag[]> {
  return listOrEmptyUntilShipped(TAGS_PATH, TagSchema);
}

export async function listCustomFieldDefinitions(): Promise<readonly CustomFieldDefinition[]> {
  return listOrEmptyUntilShipped(CUSTOM_FIELDS_PATH, CustomFieldDefinitionSchema);
}

/**
 * The write half of the definition surface — 0002 amendment 10, `tenant:settings`.
 *
 * Deliberately **not** wrapped in `listOrEmptyUntilShipped`'s `not_found`
 * tolerance. "This tenant has no vocabulary yet" is a sensible reading of a
 * missing *list*; a create that 404s is a broken deployment, and answering it
 * with a success the admin can see no result from would be worse than the error.
 *
 * There is no reorder call here yet: `POST /custom-fields/reorder` exists in the
 * contract, but nothing in this console offers a way to drag a field, and an
 * unused mutation is an endpoint nobody has exercised. Raised as follow-up on
 * TAR-33 rather than shipped untested.
 */
export async function createCustomFieldDefinition(
  input: CustomFieldDefinitionCreateInput,
): Promise<CustomFieldDefinition> {
  const response = await authenticatedRequest({
    method: 'POST',
    path: CUSTOM_FIELDS_PATH,
    body: input,
  });

  return CustomFieldDefinitionSchema.parse(response);
}

/**
 * `label` and `options` only. `key` and `type` are immutable after creation —
 * renaming the key orphans every stored value and silently stops every routing
 * rule naming it, and changing the type leaves agents holding a profile the API
 * refuses to save back. `CustomFieldDefinitionUpdateInputSchema` is what refuses
 * either; this signature is what keeps a caller from trying.
 */
export async function updateCustomFieldDefinition(
  id: string,
  input: CustomFieldDefinitionUpdateInput,
): Promise<CustomFieldDefinition> {
  const response = await authenticatedRequest({
    method: 'PATCH',
    path: `${CUSTOM_FIELDS_PATH}/${encodeURIComponent(id)}`,
    body: input,
  });

  return CustomFieldDefinitionSchema.parse(response);
}

/** Strips the key from every contact in the tenant, in the same transaction. */
export async function deleteCustomFieldDefinition(id: string): Promise<void> {
  await authenticatedRequest({
    method: 'DELETE',
    path: `${CUSTOM_FIELDS_PATH}/${encodeURIComponent(id)}`,
  });
}

async function listOrEmptyUntilShipped<T>(
  path: string,
  itemParser: { parse: (value: unknown) => T },
): Promise<readonly T[]> {
  try {
    const response = await authenticatedRequest({
      method: 'GET',
      path: `${path}?limit=${String(VOCABULARY_LIMIT)}`,
    });

    return parseCursorPage(itemParser, response).items;
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'not_found') {
      return [];
    }

    throw error;
  }
}
