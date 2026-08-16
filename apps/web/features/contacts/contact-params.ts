import { ContactListQuerySchema, IdSchema } from '@whatsappcrm/contracts';

/**
 * The directory's URL state, narrowed from untrusted query parameters.
 *
 * Validated against the *contract's* own schema rather than cast, so a
 * hand-edited `?tag=` falls back to "every contact" instead of reaching the API
 * as a malformed query. Extracted from the page so the page stays
 * composition-only and this is testable without rendering a route.
 */

export interface ContactListParams {
  /** Free text, matched by the API against name, phone and email. */
  q: string | undefined;
  /** A single tag id; `undefined` is every contact. */
  tagId: string | undefined;
}

export function parseContactListParams(raw: {
  q: string | undefined;
  tag: string | undefined;
}): ContactListParams {
  return { q: parseQuery(raw.q), tagId: parseTagId(raw.tag) };
}

function parseQuery(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = ContactListQuerySchema.shape.q.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

function parseTagId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return IdSchema.safeParse(value).success ? value : undefined;
}

/**
 * A contact id from the route segment, or `null`.
 *
 * Shape-checked rather than passed through: the API answers 422 for a path
 * parameter that is not a UUID, and an error card is the wrong answer for a
 * truncated link. Whether the id names a contact this principal may see is the
 * API's decision, and it answers `not_found` — never `forbidden`, so nothing can
 * be enumerated across tenants.
 */
export function parseContactId(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  return IdSchema.safeParse(value).success ? value : null;
}
