import type { Tag } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';

/**
 * `tags` → `Tag`.
 *
 * Lives here rather than beside contacts because a tag is its own taxonomy: the
 * contact profile, the routing-rule condition builder and TAR-27's workflow
 * references all read the same rows, and `ticket_tags` will read them next.
 *
 * **`Tag.color` is required and the column is nullable.** A tag created without
 * one gets the neutral slate below rather than being dropped from the response
 * or failing the schema — a tag with no colour is still a tag, and hiding it
 * would silently narrow a filter an agent set. Moved here unchanged from
 * `conversations/contact.mapper.ts`, so the inbox and the tag list cannot
 * disagree about what a colourless tag looks like.
 */

/**
 * The neutral colour a tag with none renders as. Slate-500 from the design
 * tokens: readable on both themes, and visibly *not* a choice somebody made.
 */
export const DEFAULT_TAG_COLOR = '#64748b';

export const TAG_PROJECTION = {
  id: true,
  name: true,
  color: true,
} as const satisfies Prisma.TagSelect;

export type TagRow = Prisma.TagGetPayload<{ select: typeof TAG_PROJECTION }>;

export function toTag(tag: TagRow): Tag {
  return { id: tag.id, name: tag.name, color: tag.color ?? DEFAULT_TAG_COLOR };
}
