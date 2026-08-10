import { Injectable } from '@nestjs/common';
import { AUDIT_ACTIONS, type SessionRevocationReason } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';

/**
 * Logs a user out, in the same transaction as the change that demands it
 * (TAR-79's amendment to ADR 0002, decision 2).
 *
 * ADR 0002 chose opaque server-side sessions over JWTs on the stated grounds
 * that "role changes take effect immediately; both are free here" — and then
 * cached the resolved principal for up to 60 seconds. Those two statements
 * contradict each other and the cache wins, so a demotion would leave up to a
 * minute of elevated access. This is what makes the original justification
 * actually true.
 *
 * Applies to any write that changes what a principal may do: `users.role`,
 * `users.status`, and team membership. The cost is one extra `DELETE` on an
 * operation that happens a few times a month per tenant. What it buys is that a
 * demoted supervisor is *logged out*, not eventually downgraded — and, as a
 * side effect, that the console's navigation (computed from the principal at
 * render time) cannot keep showing controls the user no longer has.
 *
 * `permissions` on the principal is what makes this the only invalidation path
 * worth reasoning about: it is materialised once at resolution, so killing the
 * session is the whole story. There is no second cache.
 *
 * ⚠️ TAR-35 must extend this to evict the Redis principal cache it introduces,
 * in this same transaction. Deleting the row is sufficient today only because
 * that cache does not exist yet.
 */
@Injectable()
export class SessionRevocationService {
  constructor(private readonly audit: AuditService) {}

  /**
   * Deletes every session the target holds, and records why. Returns how many
   * were killed, which is what a caller logs — zero is normal and means the
   * user was not signed in anywhere.
   *
   * `tenantId` is passed explicitly rather than read from the request scope
   * because this runs inside `$tenantTransaction`, whose client is the
   * un-extended one: the row filter has to be written, not inherited.
   */
  async revokeFor(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    reason: SessionRevocationReason,
  ): Promise<number> {
    const { count } = await tx.session.deleteMany({ where: { tenantId, userId } });

    if (count === 0) {
      // Nothing was revoked, so there is nothing to record. An audit row per
      // no-op would bury the events that matter under the ones that did not
      // happen.
      return 0;
    }

    await this.audit.record(tx, {
      action: AUDIT_ACTIONS.sessionRevoked,
      targetType: 'user',
      targetId: userId,
      metadata: { reason, sessionsRevoked: count },
    });

    return count;
  }
}
