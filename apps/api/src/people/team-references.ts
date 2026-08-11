import type { Prisma } from '../generated/prisma/client';
import { UnknownReferenceError } from './people.errors';

/**
 * Rejects any id that is not a team in this tenant.
 *
 * The composite foreign key `(tenant_id, team_id)` would refuse the write
 * anyway — that is TAR-80's guarantee and the one that actually holds — but a
 * constraint violation surfaces as a 500. This turns "team 9f… does not exist"
 * into a `validation_failed` naming the ids, which is what the caller can act on.
 *
 * Shared by the people services and by TAR-55's invites, which write the same
 * ids into `invite_teams`.
 */
export async function assertTeamsExist(
  tx: Prisma.TransactionClient,
  tenantId: string,
  teamIds: readonly string[],
): Promise<void> {
  if (teamIds.length === 0) {
    return;
  }

  const found = await tx.team.findMany({
    where: { tenantId, id: { in: [...teamIds] } },
    select: { id: true },
  });
  const known = new Set(found.map((team) => team.id));
  const unknown = [...new Set(teamIds)].filter((teamId) => !known.has(teamId));

  if (unknown.length > 0) {
    throw new UnknownReferenceError('team', unknown);
  }
}
