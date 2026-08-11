import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../../common/errors/api.exception';
import { InvalidPlatformAdminTokenError } from '../../common/security/platform-admin-credentials';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import { PlatformAdminGuard } from './platform-admin.guard';

const ALICE = 'a-platform-admin-secret-of-at-least-32-chars';
const BOB = 'another-platform-admin-secret-32-chars-plus';
const CONFIGURED = `ops-alice:${ALICE},ops-bob:${BOB}`;

describe('PlatformAdminGuard', () => {
  let tenantContext: TenantContextService;

  beforeEach(() => {
    tenantContext = new TenantContextService();
  });

  /** A context carrying just the one header the guard reads. */
  function contextWith(authorization?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          header: (name: string) =>
            name.toLowerCase() === 'authorization' ? authorization : undefined,
        }),
      }),
    } as unknown as ExecutionContext;
  }

  function guardWith(configured: string | undefined): PlatformAdminGuard {
    const config = { get: () => configured } as unknown as ConfigService;

    return new PlatformAdminGuard(config, tenantContext);
  }

  /**
   * The guard publishes onto the scope the tenant-context middleware opens, so
   * every call that expects to succeed runs inside one.
   */
  function inScope<T>(work: () => T): T {
    return tenantContext.run(
      { requestId: 'req_admin', tenantId: null, userId: null, principal: null },
      work,
    );
  }

  it('admits a request carrying a configured secret', () => {
    expect(inScope(() => guardWith(CONFIGURED).canActivate(contextWith(`Bearer ${ALICE}`)))).toBe(
      true,
    );
  });

  it('publishes the label of the credential that matched, not the secret', () => {
    // The whole point of TAR-166: the audit row a downstream service writes has
    // to be able to say *which* operator acted.
    inScope(() => {
      guardWith(CONFIGURED).canActivate(contextWith(`Bearer ${BOB}`));

      expect(tenantContext.platformActorLabel).toBe('ops-bob');
    });
  });

  it('resolves each entry to its own label', () => {
    for (const [secret, label] of [
      [ALICE, 'ops-alice'],
      [BOB, 'ops-bob'],
    ] as const) {
      inScope(() => {
        guardWith(CONFIGURED).canActivate(contextWith(`Bearer ${secret}`));

        expect(tenantContext.platformActorLabel).toBe(label);
      });
    }
  });

  it('leaves nothing on the scope when it refuses', () => {
    inScope(() => {
      expect(() => guardWith(CONFIGURED).canActivate(contextWith('Bearer wrong'))).toThrow(
        ApiException,
      );
      expect(tenantContext.platformActorLabel).toBeNull();
    });
  });

  it('refuses everything when no token is configured, rather than admitting everything', () => {
    // The property that matters most here: an environment that was never given
    // a token cannot provision tenants for whoever asks first.
    expect(() =>
      inScope(() => guardWith(undefined).canActivate(contextWith(`Bearer ${ALICE}`))),
    ).toThrow(ApiException);
    expect(() => inScope(() => guardWith('').canActivate(contextWith('Bearer ')))).toThrow(
      ApiException,
    );
  });

  it('refuses to construct on an unlabelled configuration, so the boot fails', () => {
    // No transitional dual-accept: a bare secret authenticates fine but writes
    // an audit row that cannot name who acted, which is the gap being closed.
    expect(() => guardWith(ALICE)).toThrow(InvalidPlatformAdminTokenError);
  });

  it('refuses a wrong, absent, truncated or extended secret', () => {
    const guard = guardWith(CONFIGURED);

    for (const header of [
      undefined,
      '',
      'Bearer ',
      'Bearer wrong',
      `Bearer ${ALICE.slice(0, -1)}`,
      `Bearer ${ALICE}x`,
      // The label is not a credential, and neither is the entry it appears in.
      'Bearer ops-alice',
      `Bearer ops-alice:${ALICE}`,
    ]) {
      expect(() => inScope(() => guard.canActivate(contextWith(header)))).toThrow(ApiException);
    }
  });

  it('refuses a token presented without the Bearer scheme', () => {
    const guard = guardWith(CONFIGURED);

    expect(() => inScope(() => guard.canActivate(contextWith(ALICE)))).toThrow(ApiException);
    expect(() => inScope(() => guard.canActivate(contextWith(`Basic ${ALICE}`)))).toThrow(
      ApiException,
    );
    // Case-sensitive on purpose: RFC 6750 says `Bearer`, and accepting variants
    // widens the parser for no benefit.
    expect(() => inScope(() => guard.canActivate(contextWith(`bearer ${ALICE}`)))).toThrow(
      ApiException,
    );
  });

  it('answers 401 with one indistinguishable message for every failure', () => {
    const messages = new Set<string>();

    for (const [configured, header] of [
      [CONFIGURED, undefined],
      [CONFIGURED, 'Bearer wrong'],
      [undefined, `Bearer ${ALICE}`],
    ] as const) {
      try {
        inScope(() => guardWith(configured).canActivate(contextWith(header)));
        throw new Error('expected the guard to refuse');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiException);
        const failure = error as ApiException;

        expect(failure.getStatus()).toBe(401);
        expect(failure.code).toBe('unauthenticated');
        messages.add(failure.message);
      }
    }

    // One message across all three, so the response cannot be used to tell an
    // unconfigured environment from a wrong token — or one operator's
    // credential from another's.
    expect(messages.size).toBe(1);
  });
});
