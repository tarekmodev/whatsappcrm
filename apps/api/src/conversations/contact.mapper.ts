import type { ContactResponse, Tag } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';

/**
 * `contacts` → `ContactResponse`.
 *
 * ## Why it lives here
 *
 * `ConversationResponseSchema` embeds the whole contact, so the inbox is the
 * first — and today the only — endpoint that has to produce one. TAR-33 owns
 * contacts and will bring `GET /api/v1/contacts`; when it does, this file and
 * its spec move into that module unchanged and this one imports them. Creating
 * an otherwise-empty `ContactsModule` now to hold a mapper would be the wrong
 * kind of anticipation.
 *
 * ## Three fields the schema and the column do not agree on
 *
 * Each is resolved here rather than left to the caller, so two endpoints cannot
 * answer differently:
 *
 *   * **`displayName` is `min(1)` and the column is nullable.** A contact
 *     created by an inbound message from someone with no WhatsApp profile name
 *     has none. The phone number is the fallback, which is what an agent would
 *     see in any case and is never empty — `contacts.phone_e164` is the tenant
 *     dedupe key.
 *   * **`waProfileName` has no column of its own yet.** The schema carries one
 *     `display_name`, written by the ingest pipeline from Meta's profile name
 *     and, once TAR-33 ships the editor, overridden by an agent. Until that
 *     split exists both fields read the same column: `waProfileName` is what
 *     Meta last said, `displayName` is what to render. They diverge the day the
 *     column does, and no consumer changes.
 *   * **`Tag.color` is required and the column is nullable.** A tag created
 *     without one gets the neutral slate below rather than being dropped from
 *     the response or failing the schema — a tag with no colour is still a tag,
 *     and hiding it would silently narrow a filter an agent set.
 */

/**
 * The neutral colour a tag with none renders as. Slate-500 from the design
 * tokens: readable on both themes, and visibly *not* a choice somebody made.
 */
const DEFAULT_TAG_COLOR = '#64748b';

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
  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
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
    customFields: toCustomFields(contact.customFields),
    lastContactedAt: contact.lastSeenAt?.toISOString() ?? null,
    optedOutAt: contact.optedOutAt?.toISOString() ?? null,
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}

function toTag(tag: { id: string; name: string; color: string | null }): Tag {
  return { id: tag.id, name: tag.name, color: tag.color ?? DEFAULT_TAG_COLOR };
}

/**
 * `contacts.custom_fields` as the contract publishes it: a flat map of strings
 * and nulls, keyed by `custom_field_defs.key`.
 *
 * Every other shape is dropped rather than coerced. The column is JSONB written
 * by TAR-33's editor, and a number or a nested object in it is either a
 * migration that has not happened yet or data somebody put there by hand —
 * `String(value)` would publish `[object Object]` as a field value, and failing
 * the whole response would take a tenant's inbox down over one bad row.
 */
function toCustomFields(value: unknown): Record<string, string | null> {
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
