import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import {
  AUTH_POLICY,
  permissionsForRole,
  type SessionPrincipal,
  type SessionSummary,
  type TenantRole,
} from '@whatsappcrm/contracts';
import type { SessionRevocationReason } from '../audit/audit.actions';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { uuidV7 } from '../prisma/uuid-v7';
import { SessionNotFoundError } from './identity.errors';
import { SessionCacheService } from './session-cache.service';
import { createSessionToken, hashSessionToken } from './session-token';

/**
 * Everything that happens to a session between issue and revocation (TAR-53,
 * "session lifecycle").
 *
 * ## Why this file is raw SQL rather than the Prisma client
 *
 * Every expiry comparison and every timestamp written here uses the
 * **database's** `now()`, never a Node process's clock. Two API replicas with a
 * few seconds of drift between them would otherwise disagree about whether a
 * session is alive, and the disagreement is not symmetric: the replica that is
 * fast expires a valid session, and the replica that is slow honours an expired
 * one. The Prisma client cannot express `now()` in a filter, so the statements
 * that decide whether a credential is still good are written out.
 *
 * They still run through `TenantPrisma`, so each is preceded by the
 * `app.tenant_id` GUC in the same transaction and filtered by TAR-48's
 * row-level security. That is what makes cross-tenant replay structurally
 * impossible rather than a comparison somebody has to remember to write: a
 * cookie issued for tenant A, presented at tenant B's host, matches zero rows.
 * Every value is a bound parameter — none of the SQL below is assembled from
 * anything a caller supplied.
 *
 * ## The cache is an optimisation, the database is the truth
 *
 * `SessionCacheService` can return a stale principal for at most 60 seconds and
 * can fail entirely without changing an answer. Revocation writes Postgres
 * transactionally and purges the cache on both sides of the commit, so
 * "revoked immediately, not on next expiry" holds even with Redis down.
 */

/**
 * Upper bound on `GET /auth/sessions`. The set is naturally bounded by how many
 * devices one person signs in from, which is why the contract returns a plain
 * array — but "naturally bounded" is not a promise the API can make to a
 * client, and an unbounded list is an unbounded response.
 */
const OWN_SESSIONS_LIMIT = 100;

/** `user_agent` is attacker-controlled free text; the column should not be a sink. */
const USER_AGENT_MAX_LENGTH = 512;

export interface SessionIssueInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface IssuedSession {
  /**
   * The plaintext token. It goes into the `Set-Cookie` header and nowhere else
   * — never into a response body, never into a log line, and never back into
   * the database, which holds only its SHA-256.
   */
  readonly token: string;
  readonly tokenHash: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

/** The columns `resolve` needs to build a principal, and not one more. */
interface ResolvedSessionRow {
  session_id: string;
  expires_at: Date;
  last_seen_at: Date | null;
  user_id: string;
  tenant_id: string;
  email: string;
  name: string;
  role: TenantRole;
  team_ids: string[];
}

interface OwnSessionRow {
  id: string;
  created_at: Date;
  last_seen_at: Date | null;
  expires_at: Date;
  ip_address: string | null;
  user_agent: string | null;
}

/** Anything that can run a tagged-template query: the extended client or a `tx`. */
type RawClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

@Injectable()
export class SessionService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly cache: SessionCacheService,
  ) {}

  /**
   * Writes a new session row and returns the credential for it.
   *
   * Takes the transaction rather than opening one, because the only caller that
   * should reach it — login — has to reset the lockout counters and stamp
   * `last_login_at` in the same commit. A session that exists while the
   * counters say the account is locked, or the reverse, is a half-applied
   * login.
   *
   * `expires_at` and `absolute_expires_at` are both computed by Postgres from
   * one `now()`, so the idle window and the hard cap start from the same
   * instant by construction.
   */
  async issue(tx: RawClient, input: SessionIssueInput): Promise<IssuedSession> {
    const token = createSessionToken();
    const tokenHash = hashSessionToken(token);
    const sessionId = uuidV7();

    const [row] = await tx.$queryRaw<{ expires_at: Date }[]>`
      INSERT INTO sessions (
        id, tenant_id, user_id, token_hash,
        expires_at, absolute_expires_at, last_seen_at, ip_address, user_agent, created_at
      )
      VALUES (
        ${sessionId}::uuid,
        ${input.tenantId}::uuid,
        ${input.userId}::uuid,
        ${tokenHash},
        now() + make_interval(secs => ${AUTH_POLICY.sessionIdleMs / 1_000}::double precision),
        now() + make_interval(secs => ${AUTH_POLICY.sessionAbsoluteMs / 1_000}::double precision),
        -- Seeded rather than left null, which is what starts the slide throttle
        -- running. A null would make the first request after every login pay an
        -- extra row update to push a deadline that is already seconds old.
        now(),
        ${normaliseIpAddress(input.ipAddress)}::inet,
        ${truncate(input.userAgent, USER_AGENT_MAX_LENGTH)},
        now()
      )
      RETURNING expires_at
    `;

    if (row === undefined) {
      // An `INSERT … RETURNING` that returns nothing is not a condition a
      // caller can act on — it means the statement did not run.
      throw new Error(`Session insert for user ${input.userId} returned no row.`);
    }

    return { token, tokenHash, sessionId, expiresAt: row.expires_at };
  }

  /**
   * Publishes a freshly issued session to the cache, after its transaction has
   * committed.
   *
   * Deliberately after, not inside: a cache entry written for a transaction
   * that then rolled back would be a live credential for a session that does
   * not exist — the one direction of staleness this design does not tolerate.
   */
  async publish(issued: IssuedSession, principal: SessionPrincipal): Promise<void> {
    await this.cache.track(principal.tenantId, principal.userId, issued.tokenHash);
    await this.cache.write(issued.tokenHash, principal, issued.expiresAt);
  }

  /**
   * The presented cookie → the caller, or `null` for anything that is not a
   * live session **in the tenant already in scope**.
   *
   * `null` covers every rejection — no such token, expired, revoked, past its
   * absolute cap, a user who is no longer active, and a session belonging to
   * another tenant. They are deliberately indistinguishable to the caller: a
   * response that separated them would tell an unauthenticated holder of a
   * random string something about the state of somebody's account.
   *
   * (Telling the *operator* apart is a different question. TAR-58 adds the
   * `SystemPrisma` probe that classifies a zero-row result as a cross-tenant
   * replay and emits the security event TAR-39 wants paged.)
   */
  async resolve(token: string, tenantId: string): Promise<SessionPrincipal | null> {
    const tokenHash = hashSessionToken(token);
    const cached = await this.cache.read(tokenHash);

    // The tenant check is belt and braces on top of RLS: the cached entry was
    // written under one tenant's scope, and honouring it under another would
    // reintroduce by cache exactly the replay the database makes impossible.
    if (cached !== null && cached.tenantId === tenantId) {
      return cached;
    }

    const [row] = await this.prisma.$queryRaw<ResolvedSessionRow[]>`
      SELECT s.id           AS session_id,
             s.expires_at   AS expires_at,
             s.last_seen_at AS last_seen_at,
             u.id           AS user_id,
             u.tenant_id    AS tenant_id,
             u.email::text  AS email,
             u.name         AS name,
             u.role::text   AS role,
             COALESCE(
               (SELECT array_agg(tm.team_id::text)
                  FROM team_members tm
                 WHERE tm.tenant_id = u.tenant_id AND tm.user_id = u.id),
               ARRAY[]::text[]
             )              AS team_ids
        FROM sessions s
        JOIN users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
       WHERE s.token_hash = ${tokenHash}
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND s.absolute_expires_at > now()
         AND u.status = 'active'
    `;

    if (row === undefined) {
      return null;
    }

    const expiresAt = await this.slide(
      row.session_id,
      row.user_id,
      row.last_seen_at,
      row.expires_at,
    );
    const principal = toPrincipal(row, expiresAt);

    await this.cache.write(tokenHash, principal, expiresAt);
    await this.cache.track(principal.tenantId, principal.userId, tokenHash);

    return principal;
  }

  /**
   * The caller's own live sessions, so they can drop a device they no longer
   * recognise.
   *
   * Scoped to `principal.userId` and never to a parameter: seeing somebody
   * else's devices, or their IP addresses, is not something any role grants.
   */
  async listOwn(principal: SessionPrincipal): Promise<SessionSummary[]> {
    const rows = await this.prisma.$queryRaw<OwnSessionRow[]>`
      SELECT id,
             created_at,
             last_seen_at,
             expires_at,
             ip_address::text AS ip_address,
             user_agent
        FROM sessions
       WHERE user_id = ${principal.userId}::uuid
         AND revoked_at IS NULL
         AND expires_at > now()
         AND absolute_expires_at > now()
       ORDER BY created_at DESC
       LIMIT ${OWN_SESSIONS_LIMIT}
    `;

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
      expiresAt: row.expires_at.toISOString(),
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      current: row.id === principal.sessionId,
    }));
  }

  /**
   * Revokes exactly one session, and only if it belongs to `userId`.
   *
   * The ownership filter is part of the statement rather than a check beside
   * it, so there is no separate authorization step to forget: another user's
   * session id matches zero rows, exactly as an already-revoked one does.
   *
   * The conditional `UPDATE … RETURNING` is also what makes this replay-safe. A
   * second attempt matches nothing because `revoked_at` is already set, rather
   * than succeeding twice and writing a second audit trail.
   *
   * Returns the revoked session's token hash, or `null` when nothing matched.
   */
  async revokeOne(
    tx: RawClient,
    tenantId: string,
    userId: string,
    sessionId: string,
    reason: SessionRevocationReason,
  ): Promise<string | null> {
    const [row] = await tx.$queryRaw<{ token_hash: string }[]>`
      UPDATE sessions
         SET revoked_at = now(), revoked_reason = ${reason}
       WHERE id = ${sessionId}::uuid
         AND tenant_id = ${tenantId}::uuid
         AND user_id = ${userId}::uuid
         AND revoked_at IS NULL
      RETURNING token_hash
    `;

    return row?.token_hash ?? null;
  }

  /**
   * `DELETE /auth/sessions/{id}` — the caller dropping one of their own
   * devices. Refuses anything that is not theirs and live, as `not_found`.
   */
  async revokeOwn(principal: SessionPrincipal, sessionId: string): Promise<void> {
    const tokenHash = await this.prisma.$tenantTransaction(
      async (tx) =>
        await this.revokeOne(
          tx,
          principal.tenantId,
          principal.userId,
          sessionId,
          'session_revoked',
        ),
    );

    if (tokenHash === null) {
      throw new SessionNotFoundError(sessionId);
    }

    await this.cache.forget(principal.tenantId, principal.userId, tokenHash);
  }

  /**
   * Revokes every live session a user holds, and reports how many.
   *
   * The single implementation of "log this person out everywhere", shared by
   * logout-all and by `SessionRevocationService` — which is how an admin
   * deactivating an agent terminates their access in the same transaction as
   * the status change rather than at the agent's next expiry.
   *
   * Takes the transaction client so it can join that commit. The cache purge
   * before it is half the story; `purgeCacheFor` after the commit is the other
   * half, and the caller owns that call because only the caller knows when its
   * transaction landed.
   *
   * `keepSessionId` spares exactly one session, for the single case that needs
   * it: a signed-in password change (TAR-57), where killing every *other*
   * session is the useful action after a suspected compromise and signing the
   * caller out of the tab they are typing in is not. Every other caller revokes
   * the lot, which is why it is opt-in rather than a parameter each one has to
   * think about. The spared session's cache entry is purged along with the
   * rest — it costs that one request a Postgres read and keeps the purge a
   * single unconditional statement rather than a set the caller assembles.
   */
  async revokeAllForUser(
    tx: RawClient,
    tenantId: string,
    userId: string,
    reason: SessionRevocationReason,
    keepSessionId?: string,
  ): Promise<number> {
    // Before the commit, so the common case is already cold when it lands.
    await this.cache.purgeUser(tenantId, userId);

    const revoked = await tx.$queryRaw<{ token_hash: string }[]>`
      UPDATE sessions
         SET revoked_at = now(), revoked_reason = ${reason}
       WHERE tenant_id = ${tenantId}::uuid
         AND user_id = ${userId}::uuid
         AND revoked_at IS NULL
         AND (${keepSessionId ?? null}::uuid IS NULL OR id <> ${keepSessionId ?? null}::uuid)
      RETURNING token_hash
    `;

    return revoked.length;
  }

  /**
   * The second purge, run once the revoking transaction has committed.
   *
   * Between the first purge and the commit, an in-flight request can miss the
   * cache, read the still-unrevoked row and write it back. This evicts anything
   * written in that window, which is what closes the gap between "the row says
   * revoked" and "every replica agrees". Cheap enough to call unconditionally,
   * and harmless when nothing was revoked — a purged cache entry costs one
   * extra Postgres read, not an authentication failure.
   */
  async purgeCacheFor(tenantId: string, userId: string): Promise<void> {
    await this.cache.purgeUser(tenantId, userId, true);
  }

  /**
   * Pushes the idle deadline forward, at most once every
   * `AUTH_POLICY.sessionSlideThrottleMs`, and never past the absolute cap.
   *
   * The throttle is load-bearing rather than an optimisation: extending on
   * every request would put a row update on the hot path of every API call in
   * the product, against the table every request already reads. Once per five
   * minutes makes the idle window "12 hours, ±5 minutes" — a distinction with
   * no product meaning.
   *
   * Returns the deadline now in force, so the cached principal carries the same
   * value the row does.
   */
  private async slide(
    sessionId: string,
    userId: string,
    lastSeenAt: Date | null,
    currentExpiry: Date,
  ): Promise<Date> {
    if (
      lastSeenAt !== null &&
      Date.now() - lastSeenAt.getTime() < AUTH_POLICY.sessionSlideThrottleMs
    ) {
      return currentExpiry;
    }

    const [row] = await this.prisma.$queryRaw<{ expires_at: Date }[]>`
      UPDATE sessions
         SET expires_at = LEAST(
               now() + make_interval(secs => ${AUTH_POLICY.sessionIdleMs / 1_000}::double precision),
               absolute_expires_at
             ),
             last_seen_at = now()
       WHERE id = ${sessionId}::uuid
         AND revoked_at IS NULL
         AND (
           last_seen_at IS NULL
           OR last_seen_at < now() - make_interval(
                secs => ${AUTH_POLICY.sessionSlideThrottleMs / 1_000}::double precision
              )
         )
      RETURNING expires_at
    `;

    if (row === undefined) {
      // Another replica slid it first, or the row was revoked between the read
      // and this write. Either way the deadline just read is the honest answer;
      // a revoked session is rejected on the next request rather than here.
      return currentExpiry;
    }

    // `users.last_seen_at` is the denormalised copy the people list renders —
    // reading it from `sessions` per row would make that list an aggregate.
    // Written here so it inherits the same throttle rather than inventing a
    // second one, which is exactly what the column's schema comment asks for.
    await this.prisma.$executeRaw`
      UPDATE users SET last_seen_at = now() WHERE id = ${userId}::uuid
    `;

    return row.expires_at;
  }
}

function toPrincipal(row: ResolvedSessionRow, expiresAt: Date): SessionPrincipal {
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    email: row.email,
    displayName: row.name,
    role: row.role,
    // Materialised from the role through the contract's own table, never a
    // literal list: one place in the system interprets a role, and this is not
    // it.
    permissions: [...permissionsForRole(row.role)],
    teamIds: row.team_ids,
    sessionId: row.session_id,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Keeps anything that is not an IP address out of an `inet` column.
 *
 * `req.ip` is derived from the socket, not from a header, so this is a
 * data-integrity guard rather than a security one — but an unparseable value
 * would fail the whole login statement rather than the field, and losing a
 * forensic column is not worth failing an authentication over.
 */
function normaliseIpAddress(value: string | null): string | null {
  return value !== null && isIP(value) !== 0 ? value : null;
}

function truncate(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}
