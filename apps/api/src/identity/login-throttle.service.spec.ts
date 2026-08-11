import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AUTH_POLICY } from '@whatsappcrm/contracts';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { AuthRedisClient } from './auth-redis.client';
import { TooManyAttemptsError } from './identity.errors';
import { LoginThrottleService } from './login-throttle.service';

/**
 * The three brute-force counters (TAR-59).
 *
 * They run against a fake Redis rather than a mocked service, because what is
 * under test is the *window* — that entries age out, that the allowance is
 * spent at the threshold and not before, and that two tenants cannot reach each
 * other's. A mock returning a number would assert only that a comparison
 * exists.
 *
 * The three properties worth reading twice: the keys carry the tenant, which is
 * what makes cross-tenant interference impossible by construction rather than
 * by a check; an unreachable Redis lets the attempt through, because the
 * alternative is a cache blip locking a whole tenant out of signing in; and an
 * address with no account locks exactly as one with an account does, which is
 * what keeps the 429 from answering "this account exists".
 */

const TENANT_A = '59111111-1111-7111-8111-111111111101';
const TENANT_B = '59111111-1111-7111-8111-111111111102';
const USER = '59111111-1111-7111-8111-1111111111a1';
const ADDRESS = '203.0.113.7';
const EMAIL = 'ada@acme.invalid';
const UNKNOWN_EMAIL = 'nobody@acme.invalid';

/** The key derivation restated, so a change to it has to be a deliberate one. */
function digestOf(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 32);
}

interface SortedSetEntry {
  score: number;
  member: string;
}

/**
 * Just enough Redis: the commands the service issues, against `Map`s. `exec()`
 * answers ioredis's `[error, reply][]` shape so the reply readers in the
 * service are exercised rather than bypassed.
 */
class FakeRedis {
  readonly sets = new Map<string, SortedSetEntry[]>();
  readonly expiries = new Map<string, number>();
  readonly counters = new Map<string, number>();
  /** Key → remaining TTL in ms, which is all `PTTL` is asked for here. */
  readonly locks = new Map<string, number>();

  multi(): FakeMulti {
    return new FakeMulti(this);
  }

  entries(key: string): SortedSetEntry[] {
    return this.sets.get(key) ?? [];
  }

  /** ioredis answers `-2` for a key that does not exist. */
  pttl(key: string): Promise<number> {
    return Promise.resolve(this.locks.get(key) ?? -2);
  }

  set(key: string, _value: string, unit: 'PX', ttlMs: number): Promise<'OK'> {
    expect(unit).toBe('PX');
    this.locks.set(key, ttlMs);

    return Promise.resolve('OK');
  }

  del(...keys: string[]): Promise<number> {
    // Both maps, never short-circuited: one key can be a counter and another a
    // lock in the same call, and a `||` here would silently leave one behind.
    const removed = keys.map((key) => {
      const hadCounter = this.counters.delete(key);
      const hadLock = this.locks.delete(key);

      return hadCounter || hadLock;
    });

    return Promise.resolve(removed.filter(Boolean).length);
  }
}

class FakeMulti {
  private readonly queued: (() => unknown)[] = [];

  constructor(private readonly redis: FakeRedis) {}

  zadd(key: string, score: string, member: string): this {
    return this.queue(() => {
      const entries = this.redis.entries(key);

      entries.push({ score: Number(score), member });
      this.redis.sets.set(key, entries);

      return 1;
    });
  }

  zremrangebyscore(key: string, _min: string, max: string): this {
    return this.queue(() => {
      const entries = this.redis.sets.get(key);

      if (entries === undefined) {
        // Redis does not create a key on a trim, and neither does this — the
        // difference is the whole "does a read against tenant B leave a mark"
        // question below.
        return 0;
      }

      const kept = entries.filter((entry) => entry.score > Number(max));

      this.redis.sets.set(key, kept);

      return entries.length - kept.length;
    });
  }

  zcard(key: string): this {
    return this.queue(() => this.redis.entries(key).length);
  }

  zrange(key: string, start: string, stop: string, withScores: 'WITHSCORES'): this {
    return this.queue(() => {
      // The fake implements one form of `ZRANGE`. Asserting it here is what
      // stops the fake and the service drifting apart silently.
      expect(withScores).toBe('WITHSCORES');

      return [...this.redis.entries(key)]
        .sort((left, right) => left.score - right.score)
        .slice(Number(start), Number(stop) + 1)
        .flatMap((entry) => [entry.member, String(entry.score)]);
    });
  }

  incr(key: string): this {
    return this.queue(() => {
      const next = (this.redis.counters.get(key) ?? 0) + 1;

      this.redis.counters.set(key, next);

      return next;
    });
  }

  pexpire(key: string, ttlMs: number): this {
    return this.queue(() => {
      this.redis.expiries.set(key, ttlMs);

      return 1;
    });
  }

  exec(): Promise<[Error | null, unknown][]> {
    return Promise.resolve(this.queued.map((command) => [null, command()]));
  }

  private queue(command: () => unknown): this {
    this.queued.push(command);

    return this;
  }
}

interface Harness {
  throttle: LoginThrottleService;
  redis: FakeRedis;
  statements: string[];
  audits: string[];
}

function buildHarness(options: { redisDown?: boolean; addressWindow?: boolean } = {}): Harness {
  const redis = new FakeRedis();
  const statements: string[] = [];
  const audits: string[] = [];
  let attempts = 1;

  const redisClient = {
    run: <T>(_operation: string, work: (client: unknown) => Promise<T>): Promise<T | null> =>
      options.redisDown === true ? Promise.resolve(null) : work(redis),
  } as unknown as AuthRedisClient;

  const tx = {
    $queryRaw: (strings: TemplateStringsArray): Promise<unknown[]> => {
      statements.push(strings.join(' ? '));

      const locked = attempts % AUTH_POLICY.loginFailureThreshold === 0;

      attempts += 1;

      return Promise.resolve([{ failed_login_attempts: attempts - 1, locked }]);
    },
  } as unknown as Prisma.TransactionClient;

  const prisma = {
    $tenantTransaction: (work: (client: Prisma.TransactionClient) => Promise<unknown>) => work(tx),
  } as unknown as TenantPrisma;

  const audit = {
    record: (_tx: unknown, entry: { action: string }) => {
      audits.push(entry.action);

      return Promise.resolve();
    },
  } as unknown as AuditService;

  const config = {
    get: (key: string) =>
      key === 'LOGIN_IP_THROTTLE_ENABLED' ? (options.addressWindow ?? true) : undefined,
  } as unknown as ConfigService;

  return {
    throttle: new LoginThrottleService(prisma, redisClient, audit, config),
    redis,
    statements,
    audits,
  };
}

async function failFromAddress(
  harness: Harness,
  tenantId: string,
  times: number,
  address: string = ADDRESS,
): Promise<void> {
  for (let attempt = 0; attempt < times; attempt += 1) {
    await harness.throttle.recordFailure({
      tenantId,
      userId: null,
      // A distinct address per attempt, so a spray from one client does not also
      // trip the per-email lock and confuse what these cases are measuring.
      email: `spray-${String(attempt)}@acme.invalid`,
      ipAddress: address,
    });
  }
}

async function failForEmail(
  harness: Harness,
  tenantId: string,
  times: number,
  email: string,
  userId: string | null = null,
): Promise<void> {
  for (let attempt = 0; attempt < times; attempt += 1) {
    await harness.throttle.recordFailure({ tenantId, userId, email, ipAddress: null });
  }
}

describe('the per-address failure window', () => {
  it('lets an address through until it has spent its allowance', async () => {
    const harness = buildHarness();

    await failFromAddress(harness, TENANT_A, AUTH_POLICY.ipFailureThreshold - 1);

    await expect(
      harness.throttle.assertAddressWithinLimit(TENANT_A, ADDRESS),
    ).resolves.toBeUndefined();

    await failFromAddress(harness, TENANT_A, 1);

    const error = await harness.throttle
      .assertAddressWithinLimit(TENANT_A, ADDRESS)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TooManyAttemptsError);
    expect((error as TooManyAttemptsError).retryAfterSeconds).toBeGreaterThan(0);
    // Never longer than the window itself, whatever the arithmetic does.
    expect((error as TooManyAttemptsError).retryAfterSeconds).toBeLessThanOrEqual(
      AUTH_POLICY.ipFailureWindowMs / 1_000,
    );
  });

  it('keys the window by tenant, so one tenant cannot spend the allowance of another', async () => {
    const harness = buildHarness();

    await failFromAddress(harness, TENANT_A, AUTH_POLICY.ipFailureThreshold);

    await expect(
      harness.throttle.assertAddressWithinLimit(TENANT_A, ADDRESS),
    ).rejects.toBeInstanceOf(TooManyAttemptsError);
    // The same attacker, the same address, a different tenant. TAR-59's fourth
    // acceptance criterion, satisfied by the shape of the key.
    await expect(
      harness.throttle.assertAddressWithinLimit(TENANT_B, ADDRESS),
    ).resolves.toBeUndefined();

    expect([...harness.redis.sets.keys()]).toEqual([`wac:auth:authfail:${TENANT_A}:${ADDRESS}`]);
  });

  it('separates two addresses under one tenant', async () => {
    const harness = buildHarness();

    await failFromAddress(harness, TENANT_A, AUTH_POLICY.ipFailureThreshold);

    await expect(
      harness.throttle.assertAddressWithinLimit(TENANT_A, '198.51.100.4'),
    ).resolves.toBeUndefined();
  });

  it('forgets failures that have aged out of the window', async () => {
    const harness = buildHarness();

    await failFromAddress(harness, TENANT_A, AUTH_POLICY.ipFailureThreshold);

    // Age every entry past the window rather than waiting fifteen minutes.
    const key = `wac:auth:authfail:${TENANT_A}:${ADDRESS}`;

    harness.redis.sets.set(
      key,
      harness.redis
        .entries(key)
        .map((entry) => ({ ...entry, score: entry.score - AUTH_POLICY.ipFailureWindowMs - 1 })),
    );

    await expect(
      harness.throttle.assertAddressWithinLimit(TENANT_A, ADDRESS),
    ).resolves.toBeUndefined();
    // Trimmed on read, so the set does not carry entries nothing will ever count.
    expect(harness.redis.entries(key)).toHaveLength(0);
  });

  it('expires the key one window after the last failure', async () => {
    const harness = buildHarness();

    await failFromAddress(harness, TENANT_A, 1);

    expect(harness.redis.expiries.get(`wac:auth:authfail:${TENANT_A}:${ADDRESS}`)).toBe(
      AUTH_POLICY.ipFailureWindowMs,
    );
  });

  it('hashes anything that is not an IP literal, rather than mangling it into one', async () => {
    const harness = buildHarness();

    await failFromAddress(harness, TENANT_A, 1, '203.0.113.7 and some junk');

    const [key] = [...harness.redis.sets.keys()];

    // The failure this rules out: a sanitiser that *strips* would turn
    // `203.0.113.7z` into `203.0.113.7`, letting a forged `X-Forwarded-For`
    // spend — and therefore block — a real neighbour's window.
    expect(key).toMatch(new RegExp(`^wac:auth:authfail:${TENANT_A}:sha256:[0-9a-f]{32}$`));
  });

  it('keys an IPv6 address by the address itself', async () => {
    const harness = buildHarness();

    await failFromAddress(harness, TENANT_A, 1, '2001:DB8::1');

    expect([...harness.redis.sets.keys()]).toEqual([`wac:auth:authfail:${TENANT_A}:2001:db8::1`]);
  });

  it('counts nothing when the request carried no address', async () => {
    const harness = buildHarness();

    await failForEmail(harness, TENANT_A, 1, EMAIL);

    await expect(
      harness.throttle.assertAddressWithinLimit(TENANT_A, null),
    ).resolves.toBeUndefined();
    expect(harness.redis.sets.size).toBe(0);
  });

  it('lets the attempt through when Redis is unreachable', async () => {
    const harness = buildHarness({ redisDown: true });

    // Fails open on purpose: the durable per-account lockout still protects a
    // real account, and failing closed would turn a Redis blip into a total
    // authentication outage for every tenant.
    await expect(
      harness.throttle.assertAddressWithinLimit(TENANT_A, ADDRESS),
    ).resolves.toBeUndefined();
  });

  it('counts and blocks nothing while LOGIN_IP_THROTTLE_ENABLED is off', async () => {
    const harness = buildHarness({ addressWindow: false });

    await failFromAddress(harness, TENANT_A, AUTH_POLICY.ipFailureThreshold * 2);

    // Behind a proxy `request.ip` is the load balancer, so counting it would
    // give an entire tenant one shared allowance — a denial of service wearing
    // a control's clothes.
    await expect(
      harness.throttle.assertAddressWithinLimit(TENANT_A, ADDRESS),
    ).resolves.toBeUndefined();
    expect(harness.redis.sets.size).toBe(0);
  });

  it('still counts the account and the email, so neither depends on the flag', async () => {
    const harness = buildHarness({ addressWindow: false });

    await failForEmail(harness, TENANT_A, 1, EMAIL, USER);

    expect(harness.statements).toHaveLength(1);
    // The flag exists because `request.ip` is a proxy behind a load balancer.
    // The typed address is not, so it is counted whatever the flag says — and
    // it has to be, or the lockout goes back to being an existence oracle in
    // the shipped configuration.
    expect([...harness.redis.counters.values()]).toEqual([1]);
  });
});

describe('the per-account counter', () => {
  it('increments and decides the lock in one statement', async () => {
    const harness = buildHarness();

    await harness.throttle.recordFailure({
      tenantId: TENANT_A,
      userId: USER,
      email: EMAIL,
      ipAddress: ADDRESS,
    });

    const [statement] = harness.statements;

    expect(statement).toContain('failed_login_attempts = failed_login_attempts + 1');
    // The lock decision is inside the same statement as the increment, so two
    // concurrent failures cannot both read "nine" and both write "ten".
    expect(statement).toContain('locked_until = CASE');
  });

  it('audits the transition into lockout, and only the transition', async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < AUTH_POLICY.loginFailureThreshold; attempt += 1) {
      await harness.throttle.recordFailure({
        tenantId: TENANT_A,
        userId: USER,
        email: EMAIL,
        ipAddress: ADDRESS,
      });
    }

    // One row per lockout. A row per attempt would let an unauthenticated
    // caller drive unbounded writes into the table an auditor reads.
    expect(harness.audits).toEqual(['auth.lockout']);
  });

  it('leaves the account alone when the attempt matched no user', async () => {
    const harness = buildHarness();

    await failForEmail(harness, TENANT_A, 1, UNKNOWN_EMAIL);

    expect(harness.statements).toHaveLength(0);
  });
});

/**
 * The layer that keeps the lockout from answering "this account exists".
 *
 * The per-account counter can only count for an address that has a row, so on
 * its own the eleventh wrong password answers 429 for a real account and 401
 * for an address with none — eleven requests, and the identical bodies and the
 * dummy verify are worth nothing. These cases assert the two are the same.
 */
describe('the per-email lockout', () => {
  it('locks an address that has no account exactly as it locks one that has', async () => {
    const harness = buildHarness();

    await failForEmail(harness, TENANT_A, AUTH_POLICY.loginFailureThreshold, UNKNOWN_EMAIL);
    await failForEmail(harness, TENANT_A, AUTH_POLICY.loginFailureThreshold, EMAIL, USER);

    const unknown = await harness.throttle
      .assertEmailWithinLimit(TENANT_A, UNKNOWN_EMAIL)
      .catch((thrown: unknown) => thrown);
    const known = await harness.throttle
      .assertEmailWithinLimit(TENANT_A, EMAIL)
      .catch((thrown: unknown) => thrown);

    expect(unknown).toBeInstanceOf(TooManyAttemptsError);
    expect(known).toBeInstanceOf(TooManyAttemptsError);
    // Same class, same message, same retry-after. Nothing a caller can read
    // separates an address with an account from one without.
    expect((unknown as TooManyAttemptsError).message).toBe((known as TooManyAttemptsError).message);
    expect((unknown as TooManyAttemptsError).retryAfterSeconds).toBe(
      (known as TooManyAttemptsError).retryAfterSeconds,
    );
  });

  it('lets an address through until it has spent the account allowance', async () => {
    const harness = buildHarness();

    await failForEmail(harness, TENANT_A, AUTH_POLICY.loginFailureThreshold - 1, UNKNOWN_EMAIL);

    // One short of the threshold the durable lockout uses, so the two trip on
    // the same attempt rather than one attempt apart — which would itself be
    // the distinguisher this layer exists to remove.
    await expect(
      harness.throttle.assertEmailWithinLimit(TENANT_A, UNKNOWN_EMAIL),
    ).resolves.toBeUndefined();

    await failForEmail(harness, TENANT_A, 1, UNKNOWN_EMAIL);

    await expect(
      harness.throttle.assertEmailWithinLimit(TENANT_A, UNKNOWN_EMAIL),
    ).rejects.toBeInstanceOf(TooManyAttemptsError);
  });

  it('locks for the same duration the account lockout uses', async () => {
    const harness = buildHarness();

    await failForEmail(harness, TENANT_A, AUTH_POLICY.loginFailureThreshold, UNKNOWN_EMAIL);

    expect([...harness.redis.locks.values()]).toEqual([AUTH_POLICY.loginLockoutMs]);
  });

  it('keys the lock by tenant, so one tenant cannot lock another out', async () => {
    const harness = buildHarness();

    await failForEmail(harness, TENANT_A, AUTH_POLICY.loginFailureThreshold, EMAIL, USER);

    await expect(harness.throttle.assertEmailWithinLimit(TENANT_A, EMAIL)).rejects.toBeInstanceOf(
      TooManyAttemptsError,
    );
    // The same person, the same address, a different tenant. One agent working
    // for two client organisations keeps their second sign-in.
    await expect(harness.throttle.assertEmailWithinLimit(TENANT_B, EMAIL)).resolves.toBeUndefined();
  });

  it('treats two casings of one address as one account, as citext does', async () => {
    const harness = buildHarness();

    await failForEmail(harness, TENANT_A, AUTH_POLICY.loginFailureThreshold, EMAIL.toUpperCase());

    // Two windows for one account would hand an attacker twice the allowance
    // for the price of a shift key.
    await expect(harness.throttle.assertEmailWithinLimit(TENANT_A, EMAIL)).rejects.toBeInstanceOf(
      TooManyAttemptsError,
    );
  });

  it('never puts the address itself in a key', async () => {
    const harness = buildHarness();

    await failForEmail(harness, TENANT_A, 1, EMAIL);

    const [key] = [...harness.redis.counters.keys()];

    // An email address is PII and `redis-cli KEYS` is not a place to keep a
    // list of who has an account here. It is also free text from a request
    // body, so a verbatim key would let a crafted address inject the separator.
    expect(key).toBe(`wac:auth:emailfail:${TENANT_A}:${digestOf(EMAIL)}`);
    expect(key).not.toContain(EMAIL);
  });

  it('clears the counter and the lock after a successful sign-in', async () => {
    const harness = buildHarness();

    await failForEmail(harness, TENANT_A, AUTH_POLICY.loginFailureThreshold, EMAIL, USER);
    await harness.throttle.clearEmailFailures(TENANT_A, EMAIL);

    // Whoever just proved they hold the password is not the attacker those
    // failures were accumulating against.
    await expect(harness.throttle.assertEmailWithinLimit(TENANT_A, EMAIL)).resolves.toBeUndefined();
    expect(harness.redis.counters.size).toBe(0);
    expect(harness.redis.locks.size).toBe(0);
  });

  it('lets the attempt through when Redis is unreachable', async () => {
    const harness = buildHarness({ redisDown: true });

    // Fails open, like every other Redis path here. The cost is stated rather
    // than hidden: while Redis is down the durable lockout is the only producer
    // of a 429 again, and the oracle is open again with it.
    await expect(harness.throttle.assertEmailWithinLimit(TENANT_A, EMAIL)).resolves.toBeUndefined();
  });

  it('locks again on the next multiple, not once and never after', async () => {
    const harness = buildHarness();

    await failForEmail(harness, TENANT_A, AUTH_POLICY.loginFailureThreshold, UNKNOWN_EMAIL);
    // The lock lapsing is what a patient attacker waits for; it must not hand
    // them an unlimited allowance afterwards.
    harness.redis.locks.clear();
    await failForEmail(harness, TENANT_A, AUTH_POLICY.loginFailureThreshold, UNKNOWN_EMAIL);

    await expect(
      harness.throttle.assertEmailWithinLimit(TENANT_A, UNKNOWN_EMAIL),
    ).rejects.toBeInstanceOf(TooManyAttemptsError);
  });
});

describe('clearing a lockout', () => {
  it('writes only when there is something to clear', async () => {
    const harness = buildHarness();
    const issued: unknown[] = [];

    const tx = {
      user: {
        updateMany: (args: unknown) => {
          issued.push(args);

          return Promise.resolve({ count: 0 });
        },
      },
    } as unknown as Prisma.TransactionClient;

    await expect(harness.throttle.clearAccountLock(tx, USER)).resolves.toBe(false);

    // The condition is in the statement, not in a read before it: a second
    // unlock of an already-unlocked account cannot race its way to an audit row
    // claiming it rescued somebody.
    expect(issued[0]).toMatchObject({
      where: {
        id: USER,
        OR: [{ lockedUntil: { not: null } }, { failedLoginAttempts: { gt: 0 } }],
      },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  });

  it('reports a cleared lockout', async () => {
    const harness = buildHarness();

    const tx = {
      user: { updateMany: () => Promise.resolve({ count: 1 }) },
    } as unknown as Prisma.TransactionClient;

    await expect(harness.throttle.clearAccountLock(tx, USER)).resolves.toBe(true);
  });
});
