import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTH_POLICY, SessionPrincipalSchema, type SessionPrincipal } from '@whatsappcrm/contracts';
import { Redis } from 'ioredis';

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
 */

/** Keeps session keys clear of BullMQ's, which use their own prefix. */
const KEY_PREFIX = 'wac:auth';

/**
 * Cap on how long a cache command may wait.
 *
 * Every authenticated request goes through this, so an unresponsive Redis must
 * degrade to the Postgres path quickly rather than parking commands in
 * ioredis's offline queue — which would turn "the cache is slow" into "the API
 * is down". Tight, because the fallback is one indexed read.
 */
const COMMAND_TIMEOUT_MS = 500;

@Injectable()
export class SessionCacheService implements OnApplicationShutdown {
  private readonly logger = new Logger(SessionCacheService.name);
  private readonly redisUrl: string | null;
  private client: Redis | null = null;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');

    this.redisUrl = url === undefined || url.length === 0 ? null : url;

    if (this.redisUrl === null) {
      this.logger.warn(
        'REDIS_URL is not set: every session lookup reads Postgres. Correct, and one extra ' +
          'query per authenticated request.',
      );
    }
  }

  /** The cached principal, or `null` for a miss, a bad shape, or no Redis. */
  async read(tokenHash: string): Promise<SessionPrincipal | null> {
    const cached = await this.run(
      'read',
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

    await this.run('write', async (client) => {
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
   */
  async track(tenantId: string, userId: string, tokenHash: string): Promise<void> {
    await this.run('track', async (client) => {
      const key = userSessionsKey(tenantId, userId);

      await client.sadd(key, tokenHash);
      await client.pexpire(key, AUTH_POLICY.sessionAbsoluteMs);
    });
  }

  /** Drops one session's cache entry and its place in the user's index. */
  async forget(tenantId: string, userId: string, tokenHash: string): Promise<void> {
    await this.run('forget', async (client) => {
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
    await this.run('purge', async (client) => {
      const key = userSessionsKey(tenantId, userId);
      const hashes = await client.smembers(key);

      if (hashes.length > 0) {
        await client.del(...hashes.map(sessionKey));
      }

      if (dropIndex) {
        await client.del(key);
      }
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client === null) {
      return;
    }

    // `quit` drains; `disconnect` tears down a reconnect timer a `quit` against
    // an unreachable Redis would leave armed, which would hold the process past
    // its termination grace period during exactly the incident where a clean
    // exit matters most.
    await this.client.quit().catch(() => undefined);
    this.client.disconnect();
    this.client = null;
  }

  /**
   * Runs one cache operation, or reports that it could not.
   *
   * The single place failure is swallowed, so no call site has to remember to —
   * and so "the cache is down" is one `warn` per operation naming what was
   * attempted rather than a stack trace that looks like an outage.
   */
  private async run<T>(operation: string, work: (client: Redis) => Promise<T>): Promise<T | null> {
    const client = this.connect();

    if (client === null) {
      return null;
    }

    try {
      return await work(client);
    } catch (error: unknown) {
      this.logger.warn(
        `Session cache ${operation} failed; falling back to Postgres: ${describe(error)}`,
      );
      return null;
    }
  }

  private connect(): Redis | null {
    if (this.redisUrl === null) {
      return null;
    }

    this.client ??= this.open(this.redisUrl);

    return this.client;
  }

  private open(url: string): Redis {
    const client = new Redis(url, {
      // Nothing connects until the first command, so a process that never
      // resolves a session never opens a socket.
      lazyConnect: true,
      commandTimeout: COMMAND_TIMEOUT_MS,
      // One retry, then fail to the Postgres path. The default keeps retrying
      // inside a single command, which is latency spent on a fallback that is
      // already correct.
      maxRetriesPerRequest: 1,
    });

    // Without a listener Node treats a connection `error` as unhandled and
    // takes the process down — which would turn a Redis restart into an API
    // outage, the opposite of what this cache degrading gracefully is for.
    client.on('error', (error: Error) => {
      this.logger.warn(`Session cache connection reported: ${error.message}`);
    });

    return client;
  }
}

function sessionKey(tokenHash: string): string {
  return `${KEY_PREFIX}:sess:${tokenHash}`;
}

function userSessionsKey(tenantId: string, userId: string): string {
  return `${KEY_PREFIX}:tenant:${tenantId}:user:${userId}:sessions`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
