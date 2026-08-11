import { AUTH_POLICY, type OutboundEmail } from '@whatsappcrm/contracts';
import type { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { SessionRevocationService } from '../rbac/session-revocation.service';
import { ResetTokenInvalidError } from './identity.errors';
import { PasswordResetService } from './password-reset.service';
import { PasswordService } from './password.service';
import { hashResetToken } from './reset-token';

/**
 * TAR-57's acceptance criteria against a fake transaction: the service's real
 * body runs — including the order it does things in, which is where single-use
 * and session invalidation actually live — while the database's answers are
 * whatever a test needs them to be.
 *
 * Hashing is the real `PasswordService`, so "the stored value is argon2id and
 * not the password" is asserted on the value the service would actually write.
 * Cross-tenant isolation is not testable here at all — it is a property of RLS,
 * and it is proved against real Postgres in `password-reset-isolation.int-spec.ts`.
 */

const TENANT = '0192f0ff-0000-7000-8000-0000000000c1';
const USER = '0192f0ff-0000-7000-8000-00000000d001';

/** The recorded entry, asserting there is exactly one — `noUncheckedIndexedAccess`. */
function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);

  const [item] = items;

  if (item === undefined) {
    throw new Error('expected exactly one recorded entry');
  }

  return item;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  status: string;
}

const ACTIVE_USER: UserRow = {
  id: USER,
  email: 'agent@example.invalid',
  name: 'Agent',
  status: 'active',
};

interface FakeState {
  /** What the email lookup answers. */
  user: UserRow | null;
  /** Tokens issued to this user in the last hour, for the throttle. */
  issuedThisHour: number;
  /** The `user_id` the conditional redemption returns, or none for zero rows. */
  redeems: string | null;
  /**
   * What a read of the presented token finds — both `confirm`'s pre-flight
   * refusal and the classification probe after the database refused.
   */
  storedToken: { consumedAt: Date | null; expiresAt: Date } | null;
  /** The user the redeemed token points at. */
  tokenOwner: { email: string; status: string } | null;
}

const HEALTHY: FakeState = {
  user: ACTIVE_USER,
  issuedThisHour: 0,
  redeems: USER,
  // Live: unspent, and dated well past anything the suite runs at. `confirm`
  // reads the token before it hashes, so a healthy fixture has to have one.
  storedToken: { consumedAt: null, expiresAt: new Date('2099-01-01T00:00:00.000Z') },
  tokenOwner: { email: ACTIVE_USER.email, status: 'active' },
};

interface Recorded {
  createdTokens: { tokenHash: string; expiresAt: Date; requestedIp: string | null }[];
  invalidations: number;
  userUpdates: Record<string, unknown>[];
  audits: string[];
  revocations: { userId: string; reason: string; keptSessionId?: string }[];
  /** The after-commit cache purges — the other half of "revoked immediately". */
  purges: string[];
  emails: OutboundEmail[];
}

function build(overrides: Partial<FakeState> = {}): {
  resets: PasswordResetService;
  recorded: Recorded;
  run: <T>(work: () => Promise<T>) => Promise<T>;
} {
  const state: FakeState = { ...HEALTHY, ...overrides };
  const recorded: Recorded = {
    createdTokens: [],
    invalidations: 0,
    userUpdates: [],
    audits: [],
    revocations: [],
    purges: [],
    emails: [],
  };

  const tx = {
    $queryRaw: () => Promise.resolve(state.redeems === null ? [] : [{ userId: state.redeems }]),
    passwordResetToken: {
      updateMany: () => {
        recorded.invalidations += 1;
        return Promise.resolve({ count: 1 });
      },
      create: ({ data }: { data: Recorded['createdTokens'][number] }) => {
        recorded.createdTokens.push(data);
        return Promise.resolve({ id: 'token-row' });
      },
    },
    user: {
      findUnique: () => Promise.resolve(state.tokenOwner),
      update: ({ data }: { data: Record<string, unknown> }) => {
        recorded.userUpdates.push(data);
        return Promise.resolve({ id: USER });
      },
    },
  };

  const prisma = {
    user: { findUnique: () => Promise.resolve(state.user) },
    passwordResetToken: {
      count: () => Promise.resolve(state.issuedThisHour),
      findUnique: () => Promise.resolve(state.storedToken),
    },
    $tenantTransaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as TenantPrisma;

  const mailer = {
    send: (message: OutboundEmail) => {
      recorded.emails.push(message);
      return Promise.resolve();
    },
  };

  const audit = {
    record: (_tx: unknown, entry: { action: string }) => {
      recorded.audits.push(entry.action);
      return Promise.resolve();
    },
  } as unknown as AuditService;

  const sessions = {
    revokeFor: (
      _tx: unknown,
      _tenantId: string,
      userId: string,
      reason: string,
      keptSessionId?: string,
    ) => {
      recorded.revocations.push({ userId, reason, keptSessionId });
      return Promise.resolve(2);
    },
    purgeCacheFor: (_tenantId: string, userId: string) => {
      recorded.purges.push(userId);
      return Promise.resolve();
    },
  } as unknown as SessionRevocationService;

  const tenantContext = new TenantContextService();

  return {
    resets: new PasswordResetService(
      prisma,
      mailer,
      new PasswordService(),
      tenantContext,
      audit,
      sessions,
    ),
    recorded,
    run: (work) =>
      tenantContext.run(
        { requestId: 'req_reset_spec', tenantId: TENANT, userId: null, principal: null },
        work,
      ),
  };
}

describe('PasswordResetService.request', () => {
  it('issues a single-use token and mails the link, never the plaintext elsewhere', async () => {
    const { resets, recorded, run } = build();

    await run(() => resets.request({ email: ACTIVE_USER.email }, '203.0.113.7'));

    expect(recorded.createdTokens).toHaveLength(1);
    const issued = only(recorded.createdTokens);
    const email = only(recorded.emails);

    expect(email.template).toBe('password_reset');
    expect(email.to).toBe(ACTIVE_USER.email);
    // The row holds the hash of exactly the token that was mailed, and the
    // plaintext appears nowhere else.
    expect(issued.tokenHash).toBe(hashResetToken(email.data.token ?? ''));
    expect(issued.tokenHash).not.toBe(email.data.token);
    expect(issued.requestedIp).toBe('203.0.113.7');
  });

  it('expires the token an hour out, per AUTH_POLICY', async () => {
    const { resets, recorded, run } = build();
    const before = Date.now();

    await run(() => resets.request({ email: ACTIVE_USER.email }, null));

    const ttl = only(recorded.createdTokens).expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(AUTH_POLICY.passwordResetTtlMs - 5_000);
    expect(ttl).toBeLessThanOrEqual(AUTH_POLICY.passwordResetTtlMs + 5_000);
  });

  it('invalidates the previous outstanding link before issuing a new one', async () => {
    const { resets, recorded, run } = build();

    await run(() => resets.request({ email: ACTIVE_USER.email }, null));

    expect(recorded.invalidations).toBe(1);
  });

  it('does nothing at all for an address with no account', async () => {
    const { resets, recorded, run } = build({ user: null });

    await expect(
      run(() => resets.request({ email: 'nobody@example.invalid' }, null)),
    ).resolves.toBeUndefined();

    expect(recorded.createdTokens).toHaveLength(0);
    expect(recorded.emails).toHaveLength(0);
  });

  it.each(['invited', 'suspended', 'removed'])('sends nothing to a %s user', async (status) => {
    const { resets, recorded, run } = build({ user: { ...ACTIVE_USER, status } });

    await run(() => resets.request({ email: ACTIVE_USER.email }, null));

    expect(recorded.emails).toHaveLength(0);
  });

  it('stops at the per-account hourly limit, and still reports nothing', async () => {
    const { resets, recorded, run } = build({
      issuedThisHour: AUTH_POLICY.resetRequestsPerEmailPerHour,
    });

    await expect(
      run(() => resets.request({ email: ACTIVE_USER.email }, null)),
    ).resolves.toBeUndefined();

    expect(recorded.createdTokens).toHaveLength(0);
    expect(recorded.emails).toHaveLength(0);
  });

  it('drops an unusable client address rather than failing the request', async () => {
    const { resets, recorded, run } = build();

    await run(() => resets.request({ email: ACTIVE_USER.email }, null));

    expect(only(recorded.createdTokens).requestedIp).toBeNull();
  });
});

describe('PasswordResetService.confirm', () => {
  const NEW_PASSWORD = 'a brand new passphrase';

  it('stores an argon2id hash and never the password', async () => {
    const { resets, recorded, run } = build();

    await run(() => resets.confirm({ token: 'whatever', password: NEW_PASSWORD }));

    const update = only(recorded.userUpdates);
    expect(String(update.passwordHash)).toMatch(/^\$argon2id\$/);
    expect(String(update.passwordHash)).not.toContain(NEW_PASSWORD);
  });

  it('revokes every session for the user', async () => {
    const { resets, recorded, run } = build();

    await run(() => resets.confirm({ token: 'whatever', password: NEW_PASSWORD }));

    expect(recorded.revocations).toEqual([
      { userId: USER, reason: 'password_reset', keptSessionId: undefined },
    ]);
    // Without this the sessions it just revoked keep answering from Redis for
    // up to a minute, which is exactly the window a reset exists to close.
    expect(recorded.purges).toEqual([USER]);
  });

  it('clears the lockout, so a forgotten password is actually a way back in', async () => {
    const { resets, recorded, run } = build();

    await run(() => resets.confirm({ token: 'whatever', password: NEW_PASSWORD }));

    expect(only(recorded.userUpdates)).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null });
  });

  it('audits the completion and notifies the account holder', async () => {
    const { resets, recorded, run } = build();

    await run(() => resets.confirm({ token: 'whatever', password: NEW_PASSWORD }));

    expect(recorded.audits).toContain('password.reset_completed');
    expect(recorded.emails.map((email) => email.template)).toEqual(['password_changed']);
  });

  it('issues no session: the user logs in fresh', async () => {
    const { resets, recorded, run } = build();

    await expect(
      run(() => resets.confirm({ token: 'whatever', password: NEW_PASSWORD })),
    ).resolves.toBeUndefined();

    expect(recorded.emails.every((email) => email.data.token === undefined)).toBe(true);
  });

  it.each([
    ['an unknown token', null, 'unknown'],
    [
      'an already consumed token',
      { consumedAt: new Date('2026-01-01T00:00:00.000Z'), expiresAt: new Date('2030-01-01') },
      'consumed',
    ],
    [
      'an expired token',
      { consumedAt: null, expiresAt: new Date('2020-01-01T00:00:00.000Z') },
      'expired',
    ],
  ])('refuses %s and says why', async (_label, storedToken, reason) => {
    const { resets, recorded, run } = build({ redeems: null, storedToken });

    await expect(
      run(() => resets.confirm({ token: 'whatever', password: NEW_PASSWORD })),
    ).rejects.toThrow(ResetTokenInvalidError);

    expect(recorded.userUpdates).toHaveLength(0);
    expect(recorded.revocations).toHaveLength(0);

    await run(() =>
      resets.confirm({ token: 'whatever', password: NEW_PASSWORD }).catch((error: unknown) => {
        expect((error as ResetTokenInvalidError).reason).toBe(reason);
      }),
    );
  });

  it.each([
    ['a token that was never issued', null],
    [
      'a token that was already spent',
      { consumedAt: new Date('2026-01-01T00:00:00.000Z'), expiresAt: new Date('2099-01-01') },
    ],
  ])('refuses %s without paying for an argon2id hash first', async (_label, storedToken) => {
    const { resets, run } = build({ redeems: null, storedToken });
    const hash = jest.spyOn(PasswordService.prototype, 'hash');

    try {
      await expect(
        run(() => resets.confirm({ token: 'invented', password: NEW_PASSWORD })),
      ).rejects.toThrow(ResetTokenInvalidError);

      // This route is unauthenticated and nothing rate-limits it yet (TAR-59).
      // Hashing before reading the token makes every junk request cost a full
      // argon2id pass — 19 MiB and a libuv thread — while the database sees no
      // load at all, so nothing in the existing observability points at where
      // the pressure came from.
      expect(hash).not.toHaveBeenCalled();
    } finally {
      hash.mockRestore();
    }
  });

  it('still hashes for a live token, so the pre-flight has not become the gate', async () => {
    const { resets, recorded, run } = build();

    await run(() => resets.confirm({ token: 'whatever', password: NEW_PASSWORD }));

    expect(String(only(recorded.userUpdates).passwordHash)).toMatch(/^\$argon2id\$/);
  });

  it('burns a live token presented for an account that may no longer sign in', async () => {
    const { resets, recorded, run } = build({
      tokenOwner: { email: 'x@y.invalid', status: 'suspended' },
    });

    await expect(
      run(() => resets.confirm({ token: 'whatever', password: NEW_PASSWORD })),
    ).rejects.toMatchObject({ reason: 'revoked' });

    // The redemption committed — the `UPDATE` ran — but nothing was granted.
    expect(recorded.userUpdates).toHaveLength(0);
    expect(recorded.revocations).toHaveLength(0);
  });

  it('completes even when the confirmation email cannot be sent', async () => {
    const { resets, recorded, run } = build();
    // The password is already committed by the time the mailer is reached;
    // failing here would tell the caller a change that happened did not.
    Reflect.set(resets, 'mailer', {
      send: () => Promise.reject(new Error('smtp is down')),
    });

    await expect(
      run(() => resets.confirm({ token: 'whatever', password: NEW_PASSWORD })),
    ).resolves.toBeUndefined();

    expect(recorded.userUpdates).toHaveLength(1);
  });
});
