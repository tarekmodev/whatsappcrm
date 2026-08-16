import type { Prisma } from '../generated/prisma/client';
import { UnknownTagError } from './tags.errors';

/**
 * Rejects any id that is not a tag in this tenant.
 *
 * The composite foreign key `(tenant_id, tag_id)` on `contact_tags` is what
 * actually stops tenant A tagging its contact with tenant B's tag — RLS cannot,
 * because the join row carries A's own `tenant_id` and satisfies the policy.
 * This turns that attempt into a `validation_failed` naming the ids rather than
 * a 500 from a constraint violation.
 *
 * One query for the whole set rather than one per id, and it runs inside the
 * caller's write transaction, so nothing can delete a tag between the check and
 * the insert. `people/team-references.ts`' shape, for the same reason it has one:
 * more than one service writes these ids.
 */
export async function assertTagsExist(
  tx: Prisma.TransactionClient,
  tenantId: string,
  tagIds: readonly string[],
): Promise<void> {
  if (tagIds.length === 0) {
    return;
  }

  const found = await tx.tag.findMany({
    where: { tenantId, id: { in: [...tagIds] } },
    select: { id: true },
  });
  const known = new Set(found.map((tag) => tag.id));
  const unknown = [...new Set(tagIds)].filter((tagId) => !known.has(tagId));

  if (unknown.length > 0) {
    throw new UnknownTagError(unknown);
  }
}
