import type { Redis } from 'ioredis';
import type { AuthRedisClient } from './auth-redis.client';
import { SessionCacheService } from './session-cache.service';

/**
 * The purge half of the cache: what it costs, and what it still evicts when
 * Redis answers badly (TAR-244).
 *
 * A team membership change purges everybody it touches. The loop it replaced
 * was three commands per person against a 500 ms command timeout, which is the
 * shape that turns a large team into a slow request rather than a fast one —
 * so the assertions here are about the *number of round trips*, not only the
 * keys.
 *
 * ioredis is faked rather than run: what needs proving is how this service
 * batches, and a real server would prove only that `DEL` deletes.
 */

const TENANT = '0192f0ff-0000-7000-8000-0000000000c1';
const ALICE = '0192f0ff-0000-7000-8000-00000000c001';
const BOB = '0192f0ff-0000-7000-8000-00000000c002';

const indexKey = (userId: string): string => `wac:auth:tenant:${TENANT}:user:${userId}:sessions`;
const sessionKey = (hash: string): string => `wac:auth:sess:${hash}`;

interface Harness {
  cache: SessionCacheService;
  deleted: string[][];
  pipelines: string[][];
}

/**
 * @param membersFor what `SMEMBERS` returns per index key, or `null` to make
 *   the whole pipeline fail the way a discarded `EXEC` does.
 */
function buildHarness(membersFor: ((key: string) => string[]) | null): Harness {
  const deleted: string[][] = [];
  const pipelines: string[][] = [];

  const client = {
    pipeline: () => {
      const keys: string[] = [];

      pipelines.push(keys);

      const chain = {
        smembers: (key: string) => {
          keys.push(key);
          return chain;
        },
        exec: () =>
          Promise.resolve(
            membersFor === null
              ? null
              : keys.map((key) => [null, membersFor(key)] as [Error | null, unknown]),
          ),
      };

      return chain;
    },
    del: (...keys: string[]) => {
      deleted.push(keys);
      return Promise.resolve(keys.length);
    },
  } as unknown as Redis;

  const redis = {
    run: <T>(_operation: string, work: (client: Redis) => Promise<T>) => work(client),
  } as unknown as AuthRedisClient;

  return { cache: new SessionCacheService(redis), deleted, pipelines };
}

describe('SessionCacheService.purgeUsers', () => {
  it('reads every index in one pipeline and deletes in one command', async () => {
    const harness = buildHarness((key) =>
      key === indexKey(ALICE) ? ['hash-a1', 'hash-a2'] : ['hash-b1'],
    );

    await harness.cache.purgeUsers(TENANT, [ALICE, BOB]);

    // One round trip for the reads, one for the deletes — not three per user.
    expect(harness.pipelines).toEqual([[indexKey(ALICE), indexKey(BOB)]]);
    expect(harness.deleted).toEqual([
      [sessionKey('hash-a1'), sessionKey('hash-a2'), sessionKey('hash-b1')],
    ]);
  });

  it('drops the index keys only on the after-commit pass', async () => {
    const harness = buildHarness((key) => (key === indexKey(ALICE) ? ['hash-a1'] : ['hash-b1']));

    await harness.cache.purgeUsers(TENANT, [ALICE, BOB], true);

    // The set itself goes only once every session it names is dead, which is
    // why the before-commit purge leaves it in place for this pass to read.
    expect(harness.deleted).toEqual([
      [sessionKey('hash-a1'), sessionKey('hash-b1'), indexKey(ALICE), indexKey(BOB)],
    ]);
  });

  it('still drops the index when the pipeline itself failed', async () => {
    const harness = buildHarness(null);

    await harness.cache.purgeUsers(TENANT, [ALICE], true);

    // Nothing here may throw: an entry that survives costs at most
    // `sessionCacheTtlMs` of staleness, while a throw would turn a Redis blip
    // into a failed revocation.
    expect(harness.deleted).toEqual([[indexKey(ALICE)]]);
  });

  it('does not open a connection for an empty set', async () => {
    const harness = buildHarness(() => []);

    await harness.cache.purgeUsers(TENANT, []);

    expect(harness.pipelines).toEqual([]);
    expect(harness.deleted).toEqual([]);
  });

  it('chunks the deletes so one command cannot carry a whole team', async () => {
    const hashes = Array.from({ length: 300 }, (_, index) => `hash-${index}`);
    const harness = buildHarness(() => hashes);

    await harness.cache.purgeUsers(TENANT, [ALICE]);

    // 300 hashes at a chunk size of 256. A single `DEL` naming all of them is
    // one large payload and one long server-side pause, which is exactly what
    // the command timeout leaves no room for.
    expect(harness.deleted.map((chunk) => chunk.length)).toEqual([256, 44]);
  });

  it('routes the single-user purge through the same path', async () => {
    const harness = buildHarness(() => ['hash-a1']);

    await harness.cache.purgeUser(TENANT, ALICE, true);

    expect(harness.pipelines).toEqual([[indexKey(ALICE)]]);
    expect(harness.deleted).toEqual([[sessionKey('hash-a1'), indexKey(ALICE)]]);
  });
});
