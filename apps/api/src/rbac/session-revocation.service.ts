import { Injectable } from '@nestjs/common';
import { AUDIT_ACTIONS, type SessionRevocationReason } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import { SessionService } from '../identity/session.service';

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
 * `users.status`, and team membership. The cost is one extra statement on an
 * operation that happens a few times a month per tenant. What it buys is that a
 * demoted supervisor is *logged out*, not eventually downgraded — and that an
 * admin suspending an agent ends that agent's access at the commit rather than
 * at their next expiry, which is TAR-56's fifth acceptance criterion.
 *
 * `permissions` on the principal is what makes this the only invalidation path
 * worth reasoning about: it is materialised once at resolution, so killing the
 * session is the whole story.
 *
 * ## Two halves, and why the caller owns the second
 *
 * `revokeFor` runs inside the caller's transaction: it purges the principal
 * cache, then writes `revoked_at`. Between those two moments an in-flight
 * request can miss the cache, read the still-unrevoked row and write it back —
 * so the cache has to be purged **again** once the transaction commits, and
 * only the caller knows when that happened. That second call is
 * `purgeCacheFor`, and it is safe to make unconditionally.
 */
@Injectable()
export class SessionRevocationService {
  constructor(
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Revokes every session the target holds, and records why. Returns how many
   * were killed, which is what a caller logs — zero is normal and means the
   * user was not signed in anywhere.
   *
   * A soft revoke (`revoked_at`, `revoked_reason`) rather than a delete, which
   * is a change from the first version of this file: the row is what lets the
   * trail say *why* every session for one person died at 14:03, and what lets
   * the person's own device list stop showing a session that is gone. Every
   * read path filters `revoked_at IS NULL`, so a revoked row grants nothing.
   *
   * `tenantId` is passed explicitly rather than read from the request scope
   * because this runs inside `$tenantTransaction`, whose client is the
   * un-extended one: the row filter has to be written, not inherited.
   *
   * **Calling `purgeCacheFor` once the transaction commits is mandatory, not
   * advisory.** This method on its own leaves a window in which a concurrent
   * request repopulates the principal cache from the row it is about to revoke,
   * so a caller that skips the second half keeps a revoked session answering for
   * up to `sessionCacheTtlMs`. It has already been forgotten once.
   *
   * `keepSessionId` spares exactly one session, for the single case that needs
   * it: a signed-in password change (TAR-57), where killing every *other*
   * session is the useful action after a suspected compromise and signing the
   * caller out of the tab they are typing in is not. Every other caller revokes
   * the lot, which is why it is opt-in rather than a parameter each one has to
   * think about.
   */
  async revokeFor(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    reason: SessionRevocationReason,
    keepSessionId?: string,
  ): Promise<number> {
    const count = await this.sessions.revokeAllForUser(tx, tenantId, userId, reason, keepSessionId);

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

  /**
   * The same revocation for a set of users, at a cost that does not grow with
   * the size of the set (TAR-244).
   *
   * One `UPDATE` over every target and one `INSERT` for the audit rows, in place
   * of the caller's loop — which was two round trips per person, sequentially,
   * on the one connection its transaction had taken out of the pool. A team's
   * membership is now bounded by `TEAM_MEMBERSHIP_LIMITS.membersPerTeam`, and
   * that bound is the ceiling on the payload rather than on the work.
   *
   * Audits only the users who were actually signed in somewhere, exactly as
   * `revokeFor` does: a row per no-op would bury the events that matter.
   *
   * Returns the total revoked, which is what a caller logs.
   */
  async revokeForMany(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userIds: readonly string[],
    reason: SessionRevocationReason,
  ): Promise<number> {
    const revoked = await this.sessions.revokeAllForUsers(tx, tenantId, userIds, reason);

    if (revoked.size === 0) {
      return 0;
    }

    await this.audit.recordMany(
      tx,
      [...revoked].map(([userId, sessionsRevoked]) => ({
        action: AUDIT_ACTIONS.sessionRevoked,
        targetType: 'user' as const,
        targetId: userId,
        metadata: { reason, sessionsRevoked },
      })),
    );

    return [...revoked.values()].reduce((total, count) => total + count, 0);
  }

  /**
   * The after-commit half of a revocation. Call it once the transaction that
   * contained `revokeFor` has resolved.
   *
   * Unconditional by design: a purge that was not needed costs one Postgres
   * read on somebody's next request, while a purge that was needed and skipped
   * leaves a revoked session answering for up to a minute. Calling it after a
   * transaction that revoked nothing — or that rolled back — is harmless for
   * the same reason.
   */
  async purgeCacheFor(tenantId: string, userId: string): Promise<void> {
    await this.sessions.purgeCacheFor(tenantId, userId);
  }

  /**
   * The after-commit half of `revokeForMany`, and unconditional for the same
   * reason the single one is.
   *
   * A fixed number of Redis round trips for the whole set rather than three per
   * person — see `SessionCacheService.purgeUsers`.
   */
  async purgeCacheForMany(tenantId: string, userIds: readonly string[]): Promise<void> {
    await this.sessions.purgeCacheForUsers(tenantId, userIds);
  }
}
