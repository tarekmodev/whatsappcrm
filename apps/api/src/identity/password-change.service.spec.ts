import {
  permissionsForRole,
  type OutboundEmail,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import type { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { SessionRevocationService } from '../rbac/session-revocation.service';
import { CurrentPasswordIncorrectError } from './identity.errors';
import { PasswordChangeService } from './password-change.service';
import { PasswordService } from './password.service';

const TENANT = '0192f0ff-0000-7000-8000-0000000000c2';
const USER = '0192f0ff-0000-7000-8000-00000000e001';
const SESSION = '0192f0ff-0000-7000-8000-00000000f001';

const CURRENT = 'the current passphrase';
const REPLACEMENT = 'the replacement passphrase';

const PRINCIPAL: SessionPrincipal = {
  userId: USER,
  tenantId: TENANT,
  email: 'agent@example.invalid',
  displayName: 'Agent',
  role: 'agent',
  permissions: [...permissionsForRole('agent')],
  teamIds: [],
  sessionId: SESSION,
  expiresAt: '2026-12-31T23:59:59.000Z',
};

interface Recorded {
  userUpdates: Record<string, unknown>[];
  audits: string[];
  revocations: { userId: string; reason: string; keptSessionId?: string }[];
  /** The after-commit cache purges — the other half of "revoked immediately". */
  purges: string[];
  emails: OutboundEmail[];
}

/**
 * `storedPassword` is the password the fixture account currently has, or `null`
 * for an account that has none — an invited user who never accepted.
 */
async function build(storedPassword: string | null): Promise<{
  changes: PasswordChangeService;
  recorded: Recorded;
  run: <T>(work: () => Promise<T>) => Promise<T>;
}> {
  const passwords = new PasswordService();
  const passwordHash = storedPassword === null ? null : await passwords.hash(storedPassword);

  const recorded: Recorded = {
    userUpdates: [],
    audits: [],
    revocations: [],
    purges: [],
    emails: [],
  };

  const tx = {
    user: {
      update: ({ data }: { data: Record<string, unknown> }) => {
        recorded.userUpdates.push(data);
        return Promise.resolve({ id: USER });
      },
    },
  };

  const prisma = {
    user: {
      findUnique: () => Promise.resolve({ passwordHash, email: PRINCIPAL.email }),
    },
    $tenantTransaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as TenantPrisma;

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
      return Promise.resolve(3);
    },
    purgeCacheFor: (_tenantId: string, userId: string) => {
      recorded.purges.push(userId);
      return Promise.resolve();
    },
  } as unknown as SessionRevocationService;

  const mailer = {
    send: (message: OutboundEmail) => {
      recorded.emails.push(message);
      return Promise.resolve();
    },
  };

  const tenantContext = new TenantContextService();

  return {
    changes: new PasswordChangeService(prisma, mailer, passwords, tenantContext, audit, sessions),
    recorded,
    run: (work) =>
      tenantContext.run(
        { requestId: 'req_change_spec', tenantId: TENANT, userId: null, principal: null },
        () => {
          tenantContext.setPrincipal(PRINCIPAL);
          return work();
        },
      ),
  };
}

describe('PasswordChangeService', () => {
  it('replaces the hash when the current password is right', async () => {
    const { changes, recorded, run } = await build(CURRENT);

    await run(() => changes.change({ currentPassword: CURRENT, newPassword: REPLACEMENT }));

    const [update] = recorded.userUpdates;
    expect(String(update?.passwordHash)).toMatch(/^\$argon2id\$/);
    expect(String(update?.passwordHash)).not.toContain(REPLACEMENT);
  });

  it('keeps the caller signed in and drops every other session', async () => {
    const { changes, recorded, run } = await build(CURRENT);

    await run(() => changes.change({ currentPassword: CURRENT, newPassword: REPLACEMENT }));

    expect(recorded.revocations).toEqual([
      { userId: USER, reason: 'password_change', keptSessionId: SESSION },
    ]);
    // Without this the other devices keep answering from Redis for up to a
    // minute after a change made precisely to lock them out.
    expect(recorded.purges).toEqual([USER]);
  });

  it('audits the change and notifies the account holder', async () => {
    const { changes, recorded, run } = await build(CURRENT);

    await run(() => changes.change({ currentPassword: CURRENT, newPassword: REPLACEMENT }));

    expect(recorded.audits).toEqual(['password.changed']);
    expect(recorded.emails.map((email) => email.template)).toEqual(['password_changed']);
  });

  it('refuses a wrong current password and writes nothing', async () => {
    const { changes, recorded, run } = await build(CURRENT);

    await expect(
      run(() => changes.change({ currentPassword: 'not it at all', newPassword: REPLACEMENT })),
    ).rejects.toThrow(CurrentPasswordIncorrectError);

    expect(recorded.userUpdates).toHaveLength(0);
    expect(recorded.revocations).toHaveLength(0);
    expect(recorded.emails).toHaveLength(0);
  });

  it('answers identically for an account that has no password set', async () => {
    const { changes, recorded, run } = await build(null);

    await expect(
      run(() => changes.change({ currentPassword: CURRENT, newPassword: REPLACEMENT })),
    ).rejects.toThrow(CurrentPasswordIncorrectError);

    expect(recorded.userUpdates).toHaveLength(0);
  });

  it('never takes the account from anywhere but the principal', async () => {
    const { changes, recorded, run } = await build(CURRENT);

    await run(() => changes.change({ currentPassword: CURRENT, newPassword: REPLACEMENT }));

    // There is no user id in the DTO, the route or the service signature — the
    // only account this endpoint can reach is the caller's own.
    expect(recorded.revocations.every((revocation) => revocation.userId === PRINCIPAL.userId)).toBe(
      true,
    );
  });
});
