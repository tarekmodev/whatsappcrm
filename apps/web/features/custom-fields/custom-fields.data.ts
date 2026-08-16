import 'server-only';

import type { CustomFieldDefinition } from '@whatsappcrm/contracts';
import { listCustomFieldDefinitions } from '@/lib/api/contact-schema';

/**
 * The server-side read for the custom-field admin surface.
 *
 * A thin pass-through today, and deliberately still its own module: the section
 * imports from `features/`, not from `lib/api/`, so when this surface grows a
 * second read — usage counts per field, say — no component changes.
 *
 * The list is the tenant's whole vocabulary and does not paginate:
 * `CUSTOM_FIELD_LIMITS.definitionsPerTenant` is enforced on create, so a bounded
 * response is a promise the server can keep.
 */
export async function loadCustomFieldDefinitions(): Promise<readonly CustomFieldDefinition[]> {
  return listCustomFieldDefinitions();
}
