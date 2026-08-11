import { AUTH_POLICY, permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { SessionNotFoundError } from './identity.errors';
import { SessionCacheService } from './session-cache.service';
import { hashSessionToken } from './session-token';
import { SessionService } from './session.service';

/**
 * Resolution, the sliding window and revocation.
 *
 * The cache is faked here because what needs proving is how this service
 * *treats* it — that a hit for another tenant is ignored, that a miss falls
 * through to the database rather than answering "revoked", and that a
 * revocation purges before the write as well as after. Whether Redis stores a
 * string is not in question.
 */

const TENANT = '56555555-5555-7555-8555-555555555501';
const OTHER_TENANT = '56555555-5555-7555-8555-555555555502';
const USER = '56555555-5555-7555-8555-5555555555a1';
const SESSION = '56555555-5555-7555-8555-5555555555b1';
const TOKEN = 'a-session-token';

const EXPIRES_AT = new Date('2026-08-12T09:00:00.000Z');

function principalIn(tenantId: string): SessionPrincipal {
  return {
    userId: USER,
    tenantId,
    email: 'agent@acme.invalid',
    displayName: 'Ada',
    role: 'agent',
    permissions: [...permissionsForRole('agent')],
    teamIds: [],
    sessionId: SESSION,
    expiresAt: EXPIRES_AT.toISOString(),
  };
}

function sessionRow(lastSeenAt: Date | null): Record<string, unknown> {
  return {
    session_id: SESSION,
    expires_at: EXPIRES_AT,
    last_seen_at: lastSeenAt,
    user_id: USER,
    tenant_id: TENANT,
    email: 'agent@acme.invalid',
    name: 'Ada',
    role: 'agent',
    team_ids: [],
  };
}

interface Harness {
  sessions: SessionService;
  statements: string[];
  cache: {
    read: jest.Mock;
    write: jest.Mock;
    track: jest.Mock;
    forget: jest.Mock;
    purgeUser: jest.Mock;
  };
}

function buildHarness(rowsFor: (sql: string) => unknown[]): Harness {
  const statements: string[] = [];

  const queryRaw = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const sql = strings.join(' ? ');

    statements.push(sql);

    return Promise.resolve(rowsFor(sql));
  };

  const prisma = {
    $queryRaw: queryRaw,
    $executeRaw: (strings: TemplateStringsArray) => {
      statements.push(strings.join(' ? '));
      return Promise.resolve(1);
    },
    $tenantTransaction: (work: (client: unknown) => Promise<unknown>) =>
      work({ $queryRaw: queryRaw }),
  } as unknown as TenantPrisma;

  const cache = {
    read: jest.fn().mockResolvedValue(null),
    write: jest.fn().mockResolvedValue(undefined),
    track: jest.fn().mockResolvedValue(undefined),
    forget: jest.fn().mockResolvedValue(undefined),
    purgeUser: jest.fn().mockResolvedValue(undefined),
  };

  return {
    sessions: new SessionService(prisma, cache as unknown as SessionCacheService),
    statements,
    cache,
  };
}

describe('SessionService.resolve', () => {
  it('serves a cache hit without touching the database', async () => {
    const harness = buildHarness(() => []);

    harness.cache.read.mockResolvedValue(principalIn(TENANT));

    await expect(harness.sessions.resolve(TOKEN, TENANT)).resolves.toEqual(principalIn(TENANT));
    expect(harness.statements).toEqual([]);
  });

  it('ignores a cached principal belonging to another tenant', async () => {
    // Belt and braces on top of RLS. Honouring it would reintroduce by cache
    // exactly the cross-tenant replay the database makes impossible.
    const harness = buildHarness(() => []);

    harness.cache.read.mockResolvedValue(principalIn(OTHER_TENANT));

    await expect(harness.sessions.resolve(TOKEN, TENANT)).resolves.toBeNull();
    expect(harness.statements).toHaveLength(1);
  });

  it('looks the session up by hash, never by the token itself', async () => {
    const harness = buildHarness((sql) =>
      sql.includes('FROM sessions s') ? [sessionRow(null)] : [],
    );

    await harness.sessions.resolve(TOKEN, TENANT);

    const lookup = harness.statements[0] ?? '';

    expect(lookup).toContain('s.token_hash =');
    // Every rejection is one absent row rather than a branch: expired, revoked,
    // past the absolute cap, or a user who is no longer active.
    expect(lookup).toContain('s.revoked_at IS NULL');
    expect(lookup).toContain('s.expires_at > now()');
    expect(lookup).toContain('s.absolute_expires_at > now()');
    expect(lookup).toContain("u.status = 'active'");
  });

  it('answers null when nothing matched, without saying which reason', async () => {
    const harness = buildHarness(() => []);

    await expect(harness.sessions.resolve(TOKEN, TENANT)).resolves.toBeNull();
    expect(harness.cache.write).not.toHaveBeenCalled();
  });

  it('materialises permissions from the role and caches the result', async () => {
    const harness = buildHarness((sql) =>
      sql.includes('FROM sessions s') ? [sessionRow(null)] : [],
    );

    const principal = await harness.sessions.resolve(TOKEN, TENANT);

    expect(principal).toEqual(principalIn(TENANT));
    expect(harness.cache.write).toHaveBeenCalledWith(
      hashSessionToken(TOKEN),
      principalIn(TENANT),
      EXPIRES_AT,
    );
    // Indexed so a later revocation can find it without scanning.
    expect(harness.cache.track).toHaveBeenCalledWith(TENANT, USER, hashSessionToken(TOKEN));
  });

  describe('the sliding window', () => {
    it('does not write when the session was touched inside the throttle', async () => {
      const harness = buildHarness((sql) =>
        sql.includes('FROM sessions s') ? [sessionRow(new Date())] : [],
      );

      await harness.sessions.resolve(TOKEN, TENANT);

      // Extending on every request would put a row update on the hot path of
      // every API call in the product, against the table every request reads.
      expect(harness.statements.filter((sql) => sql.includes('UPDATE sessions'))).toEqual([]);
    });

    it('extends, capped at the absolute deadline, once the throttle has elapsed', async () => {
      const stale = new Date(Date.now() - AUTH_POLICY.sessionSlideThrottleMs - 1_000);
      const slid = new Date('2026-08-13T09:00:00.000Z');
      const harness = buildHarness((sql) =>
        sql.includes('FROM sessions s')
          ? [sessionRow(stale)]
          : sql.includes('UPDATE sessions')
            ? [{ expires_at: slid }]
            : [],
      );

      const principal = await harness.sessions.resolve(TOKEN, TENANT);

      const update = harness.statements.find((sql) => sql.includes('UPDATE sessions')) ?? '';

      // `LEAST(…, absolute_expires_at)` is the hard cap: a session in daily use
      // still dies 30 days after it was issued.
      expect(update).toContain('LEAST(');
      expect(update).toContain('absolute_expires_at');
      // The cached principal carries the deadline the row now holds, not the
      // one that was read a statement earlier.
      expect(principal?.expiresAt).toBe(slid.toISOString());
    });

    it('keeps users.last_seen_at in step, under the same throttle', async () => {
      const stale = new Date(Date.now() - AUTH_POLICY.sessionSlideThrottleMs - 1_000);
      const harness = buildHarness((sql) =>
        sql.includes('FROM sessions s')
          ? [sessionRow(stale)]
          : sql.includes('UPDATE sessions')
            ? [{ expires_at: EXPIRES_AT }]
            : [],
      );

      await harness.sessions.resolve(TOKEN, TENANT);

      // The denormalised copy the people list renders. Written here so it
      // inherits this throttle rather than inventing a second one.
      expect(harness.statements.some((sql) => sql.includes('UPDATE users SET last_seen_at'))).toBe(
        true,
      );
    });
  });
});

describe('SessionService revocation', () => {
  it('scopes a single revoke to the caller inside the statement', async () => {
    const harness = buildHarness(() => [{ token_hash: 'hash' }]);

    await harness.sessions.revokeOwn(principalIn(TENANT), SESSION);

    const update = harness.statements[0] ?? '';

    // Ownership is part of the filter, so there is no separate authorization
    // step to forget — and another user's id simply matches nothing.
    expect(update).toContain('user_id =');
    expect(update).toContain('tenant_id =');
    expect(update).toContain('revoked_at IS NULL');
    expect(harness.cache.forget).toHaveBeenCalledWith(TENANT, USER, 'hash');
  });

  it('answers not-found for a session that is not live, or not yours', async () => {
    const harness = buildHarness(() => []);

    await expect(harness.sessions.revokeOwn(principalIn(TENANT), SESSION)).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('purges the cache before writing the revocation', async () => {
    const harness = buildHarness(() => [{ token_hash: 'a' }, { token_hash: 'b' }]);

    const revoked = await harness.sessions.revokeAllForUser(
      { $queryRaw: () => Promise.resolve([{ token_hash: 'a' }]) } as never,
      TENANT,
      USER,
      'status_change',
    );

    expect(revoked).toBe(1);
    // Before the commit, so the common case is already cold when it lands. The
    // caller purges again afterwards, which is what closes the window where an
    // in-flight request could repopulate it.
    expect(harness.cache.purgeUser).toHaveBeenCalledWith(TENANT, USER);
  });

  it('drops the index only on the after-commit purge', async () => {
    const harness = buildHarness(() => []);

    await harness.sessions.purgeCacheFor(TENANT, USER);

    expect(harness.cache.purgeUser).toHaveBeenCalledWith(TENANT, USER, true);
  });
});

describe('SessionService.listOwn', () => {
  it('flags the caller’s current session and bounds the query', async () => {
    const harness = buildHarness(() => [
      {
        id: SESSION,
        created_at: new Date('2026-08-11T09:00:00.000Z'),
        last_seen_at: null,
        expires_at: EXPIRES_AT,
        ip_address: '203.0.113.7',
        user_agent: 'Firefox',
      },
      {
        id: '56555555-5555-7555-8555-5555555555b2',
        created_at: new Date('2026-08-10T09:00:00.000Z'),
        last_seen_at: new Date('2026-08-10T10:00:00.000Z'),
        expires_at: EXPIRES_AT,
        ip_address: null,
        user_agent: null,
      },
    ]);

    const summaries = await harness.sessions.listOwn(principalIn(TENANT));

    expect(summaries.map((summary) => summary.current)).toEqual([true, false]);
    // "Bounded by how many devices one person uses" is not a promise the API
    // can make to a client.
    expect(harness.statements[0]).toContain('LIMIT');
    expect(harness.statements[0]).toContain('user_id =');
  });
});
