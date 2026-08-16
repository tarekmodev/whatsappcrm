import type { ContactResponse, CustomFieldValues } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import { toTag, TAG_PROJECTION } from '../tags/tag.mapper';

/**
 * `contacts` → `ContactResponse`.
 *
 * Moved here from `conversations/` by TAR-479, which is what that file said
 * would happen when TAR-33 brought `GET /api/v1/contacts`: the inbox embeds a
 * whole contact in every `ConversationResponse`, so it was the first endpoint
 * that had to produce one, and it now imports this rather than owning it. Two
 * endpoints answering differently about the same person is the failure the move
 * prevents.
 *
 * ## Two fields the schema and the column do not agree on
 *
 * Each is resolved here rather than left to the caller:
 *
 *   * **`displayName` is `min(1)` and the column is nullable.** A contact
 *     created by an inbound message from someone with no WhatsApp profile name
 *     has none. The phone number is the fallback, which is what an agent would
 *     see in any case and is never empty — `contacts.phone_e164` is the tenant
 *     dedupe key.
 *   * **`waProfileName` has no column of its own yet.** The schema carries one
 *     `display_name`, written by the ingest pipeline from Meta's profile name
 *     and overridden by an agent through `PATCH /api/v1/contacts/{id}`. Until
 *     that split exists both fields read the same column: `waProfileName` is
 *     what Meta last said, `displayName` is what to render. They diverge the day
 *     the column does, and no consumer changes.
 *
 * `Tag.color`'s nullable column is the third, and it moved to `tags/tag.mapper.ts`
 * with the rest of the tag shape.
 */

export const CONTACT_PROJECTION = {
  id: true,
  phoneE164: true,
  displayName: true,
  email: true,
  customFields: true,
  lastSeenAt: true,
  optedOutAt: true,
  createdAt: true,
  updatedAt: true,
  // Prisma resolves this as one batched query over the page's contacts rather
  // than one per row, served by `contact_tags (tenant_id, contact_id, tag_id)`.
  tags: { select: { tag: { select: TAG_PROJECTION } } },
} as const satisfies Prisma.ContactSelect;

export type ContactRow = Prisma.ContactGetPayload<{ select: typeof CONTACT_PROJECTION }>;

export function toContactResponse(contact: ContactRow): ContactResponse {
  return {
    id: contact.id,
    phone: contact.phoneE164,
    waProfileName: contact.displayName,
    displayName: contact.displayName ?? contact.phoneE164,
    email: contact.email,
    tags: contact.tags.map(({ tag }) => toTag(tag)),
    customFields: toCustomFieldValues(contact.customFields),
    lastContactedAt: contact.lastSeenAt?.toISOString() ?? null,
    optedOutAt: contact.optedOutAt?.toISOString() ?? null,
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}

/**
 * `contacts.custom_fields` as the contract publishes it: a flat map of strings
 * and nulls, keyed by `custom_field_defs.key`.
 *
 * Every other shape is dropped rather than coerced. The column is JSONB, and a
 * number or a nested object in it is either a migration that has not happened
 * yet or data somebody put there by hand — `String(value)` would publish
 * `[object Object]` as a field value, and failing the whole response would take
 * a tenant's inbox down over one bad row.
 *
 * Exported because the merge in `custom-field-values.ts` reads the stored map
 * through the same lens the response does. Reading it two ways would let a write
 * preserve a value the reader had already decided did not exist.
 */
export function toCustomFieldValues(value: unknown): CustomFieldValues {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string | null] =>
        typeof entry[1] === 'string' || entry[1] === null,
    ),
  );
}
