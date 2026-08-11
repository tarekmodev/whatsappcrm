import {
  SESSION_COOKIE_NAME,
  permissionsForRole,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import type { Request } from 'express';
import type { ReplayedSession } from '../rbac/principal.source';
import { SessionPrincipalSource } from './session-principal.source';
import type { SessionReplayProbe } from './session-replay.probe';
import type { SessionService } from './session.service';

const TENANT = '58222222-2222-7222-8222-222222222201';
const OTHER_TENANT = '58222222-2222-7222-8222-222222222202';

const PRINCIPAL: SessionPrincipal = {
  userId: '58222222-2222-7222-8222-2222222222a1',
  tenantId: TENANT,
  email: 'agent@example.invalid',
  displayName: 'Ada Agent',
  role: 'agent',
  permissions: [...permissionsForRole('agent')],
  teamIds: [],
  sessionId: '58222222-2222-7222-8222-2222222222f1',
  expiresAt: '2036-12-31T23:59:59.000Z',
};

const REPLAYED: ReplayedSession = {
  sessionId: '58222222-2222-7222-8222-2222222222f2',
  tenantId: OTHER_TENANT,
  userId: '58222222-2222-7222-8222-2222222222b1',
};

function requestWith(cookies: Record<string, string>): Request {
  return {
    method: 'GET',
    originalUrl: '/api/v1/users',
    headers: {
      cookie: Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join('; '),
    },
  } as unknown as Request;
}

function sourceWith(options: {
  principal?: SessionPrincipal | null;
  replayed?: ReplayedSession | null;
}): { source: SessionPrincipalSource; resolve: jest.Mock; classify: jest.Mock } {
  const resolve = jest.fn().mockResolvedValue(options.principal ?? null);
  const classify = jest.fn().mockResolvedValue(options.replayed ?? null);

  return {
    source: new SessionPrincipalSource(
      { resolve } as unknown as SessionService,
      {
        classify,
      } as unknown as SessionReplayProbe,
    ),
    resolve,
    classify,
  };
}

describe('SessionPrincipalSource', () => {
  it('resolves the cookie against the tenant it was given, never one from the request', async () => {
    const { source, resolve, classify } = sourceWith({ principal: PRINCIPAL });

    await expect(
      source.resolve(requestWith({ [SESSION_COOKIE_NAME]: 'a-token' }), TENANT),
    ).resolves.toEqual({ outcome: 'resolved', principal: PRINCIPAL });

    expect(resolve).toHaveBeenCalledWith('a-token', TENANT);
    // The probe is for rejections only, so a served request never pays for it.
    expect(classify).not.toHaveBeenCalled();
  });

  it('answers anonymous, and touches nothing, when no cookie was presented', async () => {
    const { source, resolve, classify } = sourceWith({});

    await expect(source.resolve(requestWith({}), TENANT)).resolves.toEqual({
      outcome: 'anonymous',
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  /**
   * TAR-53, decision 2. A cookie that resolves to nothing under this tenant's
   * RLS is an expired one, a revoked one, an invented one — or a live session
   * belonging to somebody else, which is the case worth paging on. Only the
   * probe can tell them apart, and only this outcome reaches
   * `PrincipalGuard`'s `tenant_mismatch`.
   */
  it('classifies a token that resolved to nothing as a replay when it is live elsewhere', async () => {
    const { source, classify } = sourceWith({ replayed: REPLAYED });

    await expect(
      source.resolve(requestWith({ [SESSION_COOKIE_NAME]: 'a-token' }), TENANT),
    ).resolves.toEqual({ outcome: 'replayed', session: REPLAYED });

    expect(classify).toHaveBeenCalledWith('a-token');
  });

  it('answers anonymous for a token that is live nowhere', async () => {
    const { source, classify } = sourceWith({ replayed: null });

    await expect(
      source.resolve(requestWith({ [SESSION_COOKIE_NAME]: 'expired' }), TENANT),
    ).resolves.toEqual({ outcome: 'anonymous' });

    expect(classify).toHaveBeenCalledTimes(1);
  });
});
