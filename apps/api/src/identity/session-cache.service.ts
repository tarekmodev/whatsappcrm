import { Injectable } from '@nestjs/common';
import { AUTH_POLICY, SessionPrincipalSchema, type SessionPrincipal } from '@whatsappcrm/contracts';
import { AUTH_KEY_PREFIX, AuthRedisClient } from './auth-redis.client';

/**
 * The session lookup cache, and the revocation index that makes it safe to have
 * one (TAR-53, "session cache and immediate revocation").
 *
 * Two keys, both in shared Redis rather than in process memory. That choice is
 * the whole design: an in-process LRU would need every replica told when a
 * session dies, and "revoked immediately, not on next expiry" would become a
 * fan-out problem. A shared store makes a revocation one `DEL` that every
 * replica observes.
 *
 *   * `sess:{tokenHash}` → the resolved principal, TTL 60 s.
 *   * `tenant:{tenantId}:user:{userId}:sessions` → the set of that user's live
 *     token hashes, so "log this person out everywhere" does not need a scan.
 *
 * **Both keys carry the tenant**, including the one keyed by a globally unique
 * user id. Shared infrastructure is namespaced by tenant as a rule rather than
 * per key on the merits — the moment one key is exempt, the next reviewer has
 * to work out whether this one was too.
 *
 * ## It is never the source of truth
 *
 * Postgres is. Every method here degrades to a no-op when Redis is unset or
 * unreachable, and the caller then reads `sessions` directly — one extra query
 * per request, and correct. Nothing in this file may throw: a Redis blip must
 * cost latency, never authentication. The one direction that would be unsafe —
 * treating a cache miss as "revoked" — is impossible, because a miss returns
 * `null` and `null` means "ask the database".
 *
 * ## An entry is never cached before it is indexed
 *
 * `purgeUser` can only delete what the index names, so a principal cached
 * without a matching index entry is unreachable by every revocation path and
 * answers until its TTL lapses. `track` therefore reports whether the index
 * write landed, and the two callers write the entry only when it did — a cache
 * miss costs one Postgres read, an un-purgeable entry costs a revocation.
 *
 * The connection, its timeouts and the swallowing of failures live in
 * `AuthRedisClient`, shared with TAR-59's failure window.
 */

@Injectable()
export class SessionCacheService {
  constructor(private readonly redis: AuthRedisClient) {}

  /** The cached principal, or `null` for a miss, a bad shape, or no Redis. */
  async read(tokenHash: string): Promise<SessionPrincipal | null> {
    const cached = await this.redis.run(
      'session cache read',
      async (client) => await client.get(sessionKey(tokenHash)),
    );

    if (cached === null || cached === undefined) {
      return null;
    }

    // Parsed against the contract rather than cast. A deploy that changes the
    // principal shape leaves the old one readable in Redis for up to a minute,
    // and a guard handed a half-populated principal is a guard making decisions
    // on `undefined`. A rejected entry is simply a miss.
    const parsed = SessionPrincipalSchema.safeParse(safeJsonParse(cached));

    return parsed.success ? parsed.data : null;
  }

  /**
   * Caches `principal` for at most `AUTH_POLICY.sessionCacheTtlMs`, and never
   * past the session's own expiry — a cache entry that outlived its row would
   * be exactly the stale-positive this design exists to bound.
   */
  async write(tokenHash: string, principal: SessionPrincipal, expiresAt: Date): Promise<void> {
    const ttlMs = Math.min(AUTH_POLICY.sessionCacheTtlMs, expiresAt.getTime() - Date.now());

    if (ttlMs <= 0) {
      return;
    }

    await this.redis.run('session cache write', async (client) => {
      await client.set(sessionKey(tokenHash), JSON.stringify(principal), 'PX', ttlMs);
    });
  }

  /**
   * Records `tokenHash` in the user's index, so a later revocation can find it.
   *
   * The index outlives the cache entries it names — it is the revocation
   * handle, not a cache — so it carries the session's absolute cap rather than
   * the 60-second TTL. A hash left in it for a session that has since expired
   * costs one wasted `DEL` on the next purge.
   *
   * Returns whether the hash is now indexed. `false` covers no Redis, an
   * unreachable one, and a partially applied write — every case in which a
   * later `purgeUser` might not see this hash, which is the only question the
   * caller asks before deciding to cache the principal.
   *
   * The two commands go in one `MULTI` rather than in sequence: an `SADD` whose
   * `PEXPIRE` never ran leaves the revocation index with no TTL at all, and a
   * key that is never collected is the one kind of leak a 30-day cap exists to
   * prevent.
   */
  async track(tenantId: string, userId: string, tokenHash: string): Promise<boolean> {
    const tracked = await this.redis.run('session cache track', async (client) => {
      const key = userSessionsKey(tenantId, userId);

      const replies = await client
        .multi()
        .sadd(key, tokenHash)
        .pexpire(key, AUTH_POLICY.sessionAbsoluteMs)
        .exec();

      return everyCommandSucceeded(replies);
    });

    return tracked === true;
  }

  /** Drops one session's cache entry and its place in the user's index. */
  async forget(tenantId: string, userId: string, tokenHash: string): Promise<void> {
    await this.redis.run('session cache forget', async (client) => {
      await client.del(sessionKey(tokenHash));
      await client.srem(userSessionsKey(tenantId, userId), tokenHash);
    });
  }

  /**
   * Evicts every cached principal for one user.
   *
   * Called **twice** around a revocation — once before the transaction and once
   * after it commits — and that repetition is the point. Between the first
   * purge and the commit, an in-flight request can miss the cache, read the
   * still-unrevoked row and write it back; the second purge evicts anything
   * written in that window. Purging beforehand as well means the common case is
   * already cold by the time the transaction lands.
   *
   * `dropIndex` is for the after-commit call: the set itself goes only once
   * every session it names is dead, so the before-commit purge leaves it in
   * place for the second pass to read.
   */
  async purgeUser(tenantId: string, userId: string, dropIndex = false): Promise<void> {
    await this.purgeUsers(tenantId, [userId], dropIndex);
  }

  /**
   * The same eviction for a set of users, in a fixed number of round trips
   * rather than three per person (TAR-244).
   *
   * A team membership change revokes everybody it touches, and the caller that
   * looped over them turned one supervisor's `PATCH /teams/{id}` into `3N`
   * sequential Redis commands against a 500 ms command timeout — the point at
   * which a bounded payload stops being enough on its own.
   *
   * One pipelined `SMEMBERS` per user, then chunked `DEL`s: two waits in the
   * common case, and the chunking is what keeps a single command from carrying
   * every token hash in a large team at once.
   */
  async purgeUsers(tenantId: string, userIds: readonly string[], dropIndex = false): Promise<void> {
    if (userIds.length === 0) {
      return;
    }

    await this.redis.run('session cache purge', async (client) => {
      const indexKeys = userIds.map((userId) => userSessionsKey(tenantId, userId));
      const pipeline = client.pipeline();

      for (const key of indexKeys) {
        pipeline.smembers(key);
      }

      const replies = await pipeline.exec();
      const doomed = [...readMembers(replies).map(sessionKey), ...(dropIndex ? indexKeys : [])];

      for (const chunk of chunked(doomed, DELETE_CHUNK_SIZE)) {
        await client.del(...chunk);
      }
    });
  }
}

/**
 * Keys per `DEL`. A purge for a full team can name thousands of hashes, and one
 * command carrying all of them is a single large payload and a single long
 * server-side pause — neither of which the 500 ms command timeout leaves room
 * for.
 */
const DELETE_CHUNK_SIZE = 256;

/**
 * The token hashes a pipelined batch of `SMEMBERS` returned.
 *
 * A failed element is skipped rather than thrown on, matching the rest of this
 * file: an un-purged cache entry costs at most `sessionCacheTtlMs` of staleness,
 * while a throw here would turn a Redis blip into a failed revocation.
 */
function readMembers(replies: [Error | null, unknown][] | null): string[] {
  if (replies === null) {
    return [];
  }

  return replies.flatMap(([error, value]) =>
    error === null && Array.isArray(value) ? (value as string[]) : [],
  );
}

function* chunked<T>(values: readonly T[], size: number): Generator<T[]> {
  for (let index = 0; index < values.length; index += size) {
    yield values.slice(index, index + size);
  }
}

function sessionKey(tokenHash: string): string {
  return `${AUTH_KEY_PREFIX}:sess:${tokenHash}`;
}

function userSessionsKey(tenantId: string, userId: string): string {
  return `${AUTH_KEY_PREFIX}:tenant:${tenantId}:user:${userId}:sessions`;
}

/**
 * ioredis reports a discarded `EXEC` as `null` and a per-command failure as the
 * first half of that command's `[error, reply]` pair. Either means the index
 * write cannot be assumed to have landed.
 */
function everyCommandSucceeded(replies: [Error | null, unknown][] | null): boolean {
  return replies !== null && replies.every(([error]) => error === null);
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
