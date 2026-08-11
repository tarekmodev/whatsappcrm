import type { ExecutionContext } from '@nestjs/common';
import { permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import type { Request } from 'express';
import { ApiException } from '../common/errors/api.exception';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PrincipalGuard } from './principal.guard';
import type { PrincipalSource } from './principal.source';

const TENANT = '0192f0ff-0000-7000-8000-0000000000b1';
const OTHER_TENANT = '0192f0ff-0000-7000-8000-0000000000b2';

function principalIn(tenantId: string): SessionPrincipal {
  return {
    userId: '0192f0ff-0000-7000-8000-00000000a001',
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

const CONTEXT = {
  switchToHttp: () => ({ getRequest: () => ({}) as Request }),
} as unknown as ExecutionContext;

function guardResolving(principal: SessionPrincipal | null): {
  guard: PrincipalGuard;
  tenantContext: TenantContextService;
} {
  const tenantContext = new TenantContextService();
  const source: PrincipalSource = { resolve: () => Promise.resolve(principal) };

  return { guard: new PrincipalGuard(source, tenantContext), tenantContext };
}

async function activate(
  principal: SessionPrincipal | null,
  hostTenantId: string | null,
): Promise<{ admitted: boolean; published: SessionPrincipal | null }> {
  const { guard, tenantContext } = guardResolving(principal);

  return tenantContext.run(
    { requestId: 'req_principal_guard', tenantId: hostTenantId, userId: null, principal: null },
    async () => ({
      admitted: await guard.canActivate(CONTEXT),
      published: tenantContext.principal,
    }),
  );
}

async function refusal(
  principal: SessionPrincipal | null,
  hostTenantId: string,
): Promise<ApiException> {
  try {
    await activate(principal, hostTenantId);
  } catch (error) {
    return error as ApiException;
  }

  throw new Error('expected the guard to refuse');
}

describe('PrincipalGuard', () => {
  it('publishes a principal whose tenant matches the host', async () => {
    const result = await activate(principalIn(TENANT), TENANT);

    expect(result.admitted).toBe(true);
    expect(result.published?.tenantId).toBe(TENANT);
    expect(result.published?.userId).toBe('0192f0ff-0000-7000-8000-00000000a001');
  });

  it('answers unauthenticated when there is no caller', async () => {
    const failure = await refusal(null, TENANT);

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
    const { guard, tenantContext } = guardResolving(principalIn(OTHER_TENANT));

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

    expect((await refusal(principalIn(OTHER_TENANT), TENANT)).code).toBe('tenant_mismatch');
  });

  // Fails as a wiring bug rather than as a 401, because a 401 here would read
  // as "nobody is signed in" when the truth is that no tenant was resolved and
  // the guard order is wrong.
  it('refuses to run at all without a tenant in scope', async () => {
    await expect(activate(principalIn(TENANT), null)).rejects.toThrow(
      /must be declared after HostTenantGuard/,
    );
  });
});
