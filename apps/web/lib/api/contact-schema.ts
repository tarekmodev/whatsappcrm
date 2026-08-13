import 'server-only';

import {
  CustomFieldDefinitionSchema,
  TagSchema,
  type CustomFieldDefinition,
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

/** Bounded, like every other list read in this app. A tenant's tag set is small. */
const VOCABULARY_PAGE_SIZE = 100;

export async function listTags(): Promise<readonly Tag[]> {
  return listOrEmptyUntilShipped(TAGS_PATH, TagSchema);
}

export async function listCustomFieldDefinitions(): Promise<readonly CustomFieldDefinition[]> {
  return listOrEmptyUntilShipped(CUSTOM_FIELDS_PATH, CustomFieldDefinitionSchema);
}

async function listOrEmptyUntilShipped<T>(
  path: string,
  itemParser: { parse: (value: unknown) => T },
): Promise<readonly T[]> {
  try {
    const response = await authenticatedRequest({
      method: 'GET',
      path: `${path}?limit=${String(VOCABULARY_PAGE_SIZE)}`,
    });

    return parseCursorPage(itemParser, response).items;
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'not_found') {
      return [];
    }

    throw error;
  }
}
