import { Inject, Injectable } from '@nestjs/common';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';
import type { ReplayedSession } from '../rbac/principal.source';
import { hashSessionToken } from './session-token';

/** The three uuid columns the probe selects, in Postgres' spelling. */
interface ReplayedSessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
}

/**
 * Classifies a session token that resolved to nothing inside the tenant in scope
 * (TAR-53, decision 2 — "classify the rejection with a probe, never with an
 * access path"; TAR-58 implements it).
 *
 * ## Why this needs `SystemPrisma`, and why that is allowed here
 *
 * The session lookup runs under `TenantPrisma` with the host's tenant in scope,
 * so a cookie issued for another tenant matches zero rows — RLS *is* the replay
 * defence. The cost is that the zero-row result is indistinguishable from an
 * expired or invented token, and the naive implementation answers
 * `unauthenticated` for all three while the security event TAR-39 wants paged
 * never fires.
 *
 * This is the sixth entry on ADR 0002's `SystemPrisma` call-site list, added
 * deliberately by TAR-53's Amendment 2 and held to that amendment's bar:
 *
 *   * **Read-only.** One `SELECT`. Nothing on this path writes, which is what
 *     keeps an unauthenticated caller from having a write primitive against a
 *     tenant-scoped table — the reason the earlier "write an `audit_logs` row"
 *     design was rejected.
 *   * **Nothing returned to a caller.** Three uuids, consumed by a log line. The
 *     response is the published `tenant_mismatch` envelope and carries none of
 *     them.
 *   * **Only on a path that has already decided to reject.** It never runs for a
 *     request that is being served, so it is off the hot path by construction.
 *
 * The token and its hash appear in neither the return value nor any log line.
 *
 * ## Liveness matches `SessionService.resolve`
 *
 * Same three conditions — not revoked, inside the idle window, inside the
 * absolute cap — so "live somewhere else" means exactly what "live here" would
 * have meant. A looser condition here would report a session the application
 * would itself refuse, and page somebody for a cookie that is simply old.
 */
@Injectable()
export class SessionReplayProbe {
  constructor(@Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma) {}

  /** The live session this token names in another tenant, or `null`. */
  async classify(token: string): Promise<ReplayedSession | null> {
    const [row] = await this.systemPrisma.$queryRaw<ReplayedSessionRow[]>`
      SELECT id, tenant_id, user_id
        FROM sessions
       WHERE token_hash = ${hashSessionToken(token)}
         AND revoked_at IS NULL
         AND expires_at > now()
         AND absolute_expires_at > now()
       LIMIT 1
    `;

    if (row === undefined) {
      return null;
    }

    return { sessionId: row.id, tenantId: row.tenant_id, userId: row.user_id };
  }
}
