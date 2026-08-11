import { Logger, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import type { Request } from 'express';
import { ApiException } from '../common/errors/api.exception';
import { PlatformRoute, Public } from '../common/request-pipeline/route-access';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PrincipalGuard } from './principal.guard';
import {
  ANONYMOUS,
  resolved,
  type PrincipalResolution,
  type PrincipalSource,
  type ReplayedSession,
} from './principal.source';

const TENANT = '0192f0ff-0000-7000-8000-0000000000b1';
const OTHER_TENANT = '0192f0ff-0000-7000-8000-0000000000b2';
const USER = '0192f0ff-0000-7000-8000-00000000a001';

function principalIn(tenantId: string): SessionPrincipal {
  return {
    userId: USER,
    tenantId,
    email: 'agent@example.invalid',
    displayName: 'Ada Agent',
    role: 'agent',
    permissions: [...permissionsForRole('agent')],
    teamIds: [],
    sessionId: '0192f0ff-0000-7000-8000-0000000000ff',
    expiresAt: '2026-12-31T23:59:59.000Z',
  };
}

const REQUEST = {
  method: 'GET',
  originalUrl: '/api/v1/users?cursor=secret',
} as unknown as Request;

/**
 * A context carrying whatever the route-access decorators would have set. The
 * guard reads them through a real `Reflector`, so applying the decorator to a
 * throwaway class is the same code path a controller takes.
 */
function contextFor(...decorators: readonly ((target: object) => void)[]): ExecutionContext {
  class RouteController {}

  for (const decorate of decorators) {
    decorate(RouteController);
  }

  const handler = (): void => undefined;

  return {
    getHandler: () => handler,
    getClass: () => RouteController,
    switchToHttp: () => ({ getRequest: () => REQUEST }),
  } as unknown as ExecutionContext;
}

const CONTEXT = contextFor();

function guardResolving(resolution: PrincipalResolution): {
  guard: PrincipalGuard;
  tenantContext: TenantContextService;
} {
  const tenantContext = new TenantContextService();
  const source: PrincipalSource = { resolve: () => Promise.resolve(resolution) };

  return { guard: new PrincipalGuard(new Reflector(), source, tenantContext), tenantContext };
}

/** The live session in another tenant that `SessionReplayProbe` would report. */
const REPLAYED: ReplayedSession = {
  sessionId: '0192f0ff-0000-7000-8000-0000000000ff',
  tenantId: OTHER_TENANT,
  userId: USER,
};

async function activate(
  resolution: PrincipalResolution,
  hostTenantId: string | null,
  context: ExecutionContext = CONTEXT,
): Promise<{ admitted: boolean; published: SessionPrincipal | null }> {
  const { guard, tenantContext } = guardResolving(resolution);

  return tenantContext.run(
    { requestId: 'req_principal_guard', tenantId: hostTenantId, userId: null, principal: null },
    async () => ({
      admitted: await guard.canActivate(context),
      published: tenantContext.principal,
    }),
  );
}

async function refusal(
  resolution: PrincipalResolution,
  hostTenantId: string,
): Promise<ApiException> {
  try {
    await activate(resolution, hostTenantId);
  } catch (error) {
    return error as ApiException;
  }

  throw new Error('expected the guard to refuse');
}

describe('PrincipalGuard', () => {
  it('publishes a principal whose tenant matches the host', async () => {
    const result = await activate(resolved(principalIn(TENANT)), TENANT);

    expect(result.admitted).toBe(true);
    expect(result.published?.tenantId).toBe(TENANT);
    expect(result.published?.userId).toBe(USER);
  });

  it('answers unauthenticated when there is no caller', async () => {
    const failure = await refusal(ANONYMOUS, TENANT);

    expect(failure.code).toBe('unauthenticated');
    expect(failure.getStatus()).toBe(401);
  });

  /**
   * The case worth its own error code: a session being replayed against another
   * tenant's domain. `tenant_mismatch` rather than `forbidden`, because it is a
   * security event to alert on rather than an ordinary permission failure — and
   * it is refused before the principal is published, so nothing downstream ever
   * sees a caller from the wrong tenant.
   */
  it('refuses a session presented at another tenant’s host, and publishes nothing', async () => {
    const { guard, tenantContext } = guardResolving({ outcome: 'replayed', session: REPLAYED });

    await tenantContext.run(
      { requestId: 'req_replay', tenantId: TENANT, userId: null, principal: null },
      async () => {
        await expect(guard.canActivate(CONTEXT)).rejects.toBeInstanceOf(ApiException);
        expect(tenantContext.principal).toBeNull();
        // The host's tenant is still what is in scope, so nothing downstream can
        // read the replayed session's tenant even if it ignores the refusal.
        expect(tenantContext.tenantId).toBe(TENANT);
      },
    );

    expect((await refusal({ outcome: 'replayed', session: REPLAYED }, TENANT)).code).toBe(
      'tenant_mismatch',
    );
  });

  /**
   * Defence in depth. `SessionPrincipalSource` cannot produce this — its lookup
   * runs under RLS — but the interim role stub resolves without one underneath
   * it, and so might whatever a later story binds. A source that hands over a
   * caller from another tenant must be refused by the guard rather than trusted.
   */
  it('refuses a resolved principal whose tenant disagrees with the host', async () => {
    const failure = await refusal(resolved(principalIn(OTHER_TENANT)), TENANT);

    expect(failure.code).toBe('tenant_mismatch');
  });

  /**
   * TAR-58 AC2 and TAR-53's decision 2: the attempt is rejected *and* emitted as
   * a security event. Without a line naming both tenants and the session's user,
   * a replay is indistinguishable from a bookmark on the wrong subdomain, and
   * nobody can tell whether one account is probing every customer's host.
   *
   * This asserts the fallback shape — `AppLoggerService` is absent here, as it
   * is in any narrow testing module — so what is checked is the field *content*.
   * In the application the same fields go out as structured JSON.
   */
  it('emits the security event with both tenants, the session, the user and the target', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      await refusal({ outcome: 'replayed', session: REPLAYED }, TENANT);

      const line = String(warn.mock.calls[0]?.[0]);

      expect(line).toContain('auth.tenant_mismatch');
      expect(line).toContain(OTHER_TENANT);
      expect(line).toContain(TENANT);
      expect(line).toContain(USER);
      expect(line).toContain(REPLAYED.sessionId);
      expect(line).toContain('/api/v1/users');
      // The query string is where a reset or invite token travels, and this line
      // is written exactly when somebody is doing something they should not be.
      expect(line).not.toContain('secret');
    } finally {
      warn.mockRestore();
    }
  });

  // Fails as a wiring bug rather than as a 401, because a 401 here would read
  // as "nobody is signed in" when the truth is that no tenant was resolved and
  // the guard order is wrong.
  it('refuses to run at all without a tenant in scope', async () => {
    await expect(activate(resolved(principalIn(TENANT)), null)).rejects.toThrow(
      /must be declared after HostTenantGuard/,
    );
  });

  /**
   * The two exemptions the global installation needs (TAR-58). Both admit
   * without consulting the source at all — a public route has nobody to resolve
   * yet, and a platform route has no tenant to resolve them against.
   */
  it.each([
    ['@Public()', Public],
    ['@PlatformRoute()', PlatformRoute],
  ])('admits a %s route without resolving a caller', async (_label, decorator) => {
    const context = contextFor(decorator());
    const result = await activate(ANONYMOUS, TENANT, context);

    expect(result.admitted).toBe(true);
    expect(result.published).toBeNull();
  });

  it('admits a @PlatformRoute() route even with no tenant resolved', async () => {
    const context = contextFor(PlatformRoute());

    await expect(activate(ANONYMOUS, null, context)).resolves.toEqual({
      admitted: true,
      published: null,
    });
  });

  /**
   * The load-bearing negative: a route that says nothing gets no exemption. An
   * absent decorator must never read as an opt-out, or every future endpoint is
   * one forgotten line away from being open.
   */
  it('gives an undecorated route no exemption', async () => {
    expect((await refusal(ANONYMOUS, TENANT)).code).toBe('unauthenticated');
  });
});
