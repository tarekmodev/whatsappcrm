import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  TENANT_STATUSES,
  permissionsForRole,
  type SessionPrincipal,
  type TenantRole,
  type TenantStatus,
} from '@whatsappcrm/contracts';
import { ApiException } from '../errors/api.exception';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { AVAILABLE_WHILE_SUSPENDED, PLATFORM_ROUTE, PUBLIC_ROUTE } from './route-access';
import { TenantStatusGuard } from './tenant-status.guard';

/**
 * Stage 4, status × role × route — the matrix ADR 0009 Amendment 1 ruling 1 asks
 * for by name.
 *
 * It has to be tested **directly** rather than by observing that the database
 * refuses, and that is the whole reason this file exists: after the ruling the
 * gate admits a suspended tenant, so this guard is the only thing between that
 * tenant's agent and the API. Anything it lets through is served.
 *
 * `request-pipeline.http.spec.ts` covers the same rules end to end, through the
 * real pipeline. This one covers the decision in isolation, exhaustively over
 * every status the contract publishes, so a status added later cannot arrive
 * with no rule.
 */

const TENANT_ID = '5b111111-1111-7111-8111-111111111101';

/** The three postures this guard reads, and the flag that is not a posture. */
type RouteFlags = Partial<
  Record<typeof PUBLIC_ROUTE | typeof PLATFORM_ROUTE | typeof AVAILABLE_WHILE_SUSPENDED, boolean>
>;

function principalWith(role: TenantRole): SessionPrincipal {
  return {
    userId: '5b111111-1111-7111-8111-1111111111a1',
    tenantId: TENANT_ID,
    email: 'someone@example.invalid',
    displayName: 'Someone',
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [],
    sessionId: '5b111111-1111-7111-8111-1111111111f1',
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

describe('TenantStatusGuard', () => {
  let tenantContext: TenantContextService;
  let guard: TenantStatusGuard;

  beforeEach(() => {
    tenantContext = new TenantContextService();
    guard = new TenantStatusGuard(new Reflector(), tenantContext);
  });

  /**
   * A minimal `ExecutionContext` whose handler and class carry `flags` as Nest
   * metadata — which is how `Reflector.getAllAndOverride` reads a decorator, so
   * the real `Reflector` is used rather than a stub of it.
   */
  function contextWith(flags: RouteFlags): ExecutionContext {
    const handler = (): void => undefined;

    for (const [key, value] of Object.entries(flags)) {
      Reflect.defineMetadata(key, value, handler);
    }

    return {
      getHandler: () => handler,
      getClass: () => class Probe {},
    } as unknown as ExecutionContext;
  }

  /** Runs the guard as if the pipeline had resolved `status` and `role`. */
  function decide(
    status: TenantStatus | null,
    role: TenantRole | null,
    flags: RouteFlags = {},
  ): boolean | ApiException | Error {
    return tenantContext.run(
      { requestId: 'req_status_guard', tenantId: TENANT_ID, userId: null },
      () => {
        if (status !== null) {
          tenantContext.setTenantStatus(status);
        }

        if (role !== null) {
          tenantContext.setPrincipal(principalWith(role));
        }

        try {
          return guard.canActivate(contextWith(flags));
        } catch (error: unknown) {
          return error as Error;
        }
      },
    );
  }

  describe('the statuses that serve everyone', () => {
    it.each(['trialing', 'active', 'past_due'] as const)('admits every role on %s', (status) => {
      for (const role of ['agent', 'supervisor', 'admin'] as const) {
        expect(decide(status, role)).toBe(true);
      }
    });

    it('treats `past_due` as a banner rather than an outage', () => {
      // `TENANT_STATUS_EFFECTS.past_due.apiAccess` has said so since the contract
      // was published, and this guard reads that table rather than restating it.
      // Suspending a tenant the moment a card fails would be a fortnight early.
      expect(decide('past_due', 'agent')).toBe(true);
    });
  });

  describe('the statuses that close the product', () => {
    it.each(['suspended', 'cancelled'] as const)('refuses an agent on %s', (status) => {
      const refusal = decide(status, 'agent');

      expect(refusal).toBeInstanceOf(ApiException);
      expect((refusal as ApiException).code).toBe('subscription_inactive');
    });

    it.each(['suspended', 'cancelled'] as const)('refuses a supervisor on %s', (status) => {
      expect(decide(status, 'supervisor')).toBeInstanceOf(ApiException);
    });

    it.each(['suspended', 'cancelled'] as const)(
      'refuses an admin on an ordinary route on %s',
      (status) => {
        // The admin's way back in is four routes, not the product.
        expect(decide(status, 'admin')).toBeInstanceOf(ApiException);
      },
    );
  });

  describe('the recovery allowlist', () => {
    it.each(['suspended', 'cancelled'] as const)('admits an admin on %s', (status) => {
      expect(decide(status, 'admin', { [AVAILABLE_WHILE_SUSPENDED]: true })).toBe(true);
    });

    it.each(['agent', 'supervisor'] as const)('still refuses a %s on it', (role) => {
      // Both halves are required. The decorator alone would open the route to
      // every agent in a suspended tenant, which is TAR-36's fourth acceptance
      // criterion inverted.
      expect(decide('suspended', role, { [AVAILABLE_WHILE_SUSPENDED]: true })).toBeInstanceOf(
        ApiException,
      );
    });

    it('reads the flag from the route rather than from a path list', () => {
      // A route that says nothing is closed. That inversion is what stops a
      // wildcard in a guard's path list from eventually opening something
      // nobody meant.
      expect(decide('suspended', 'admin', {})).toBeInstanceOf(ApiException);
    });
  });

  describe('what it stands down for', () => {
    it('skips a platform route, which has no tenant and no principal', () => {
      expect(decide(null, null, { [PLATFORM_ROUTE]: true })).toBe(true);
    });

    it('skips a public route, so login can authenticate before it refuses', () => {
      // ADR 0009 decision 2: checking the status before a password is verified
      // turns login into a role oracle — an unauthenticated caller could learn
      // per address whether it belongs to an admin. `AuthService` makes that
      // check after the principal is resolved.
      expect(decide('suspended', null, { [PUBLIC_ROUTE]: true })).toBe(true);
    });
  });

  describe('fail-closed wiring', () => {
    it('throws a wiring error, not a refusal, when no status was resolved', () => {
      const failure = decide(null, 'agent');

      // Not an `ApiException`: this means the guard was mounted without
      // `HostTenantGuard` in front of it, which is a bug in the module rather
      // than something a caller did.
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ApiException);
    });

    it('has a rule for every status the contract publishes', () => {
      // Exhaustive on purpose. A status added to `TENANT_STATUSES` without a
      // `TENANT_STATUS_EFFECTS` row would fail here rather than on the first
      // request that reached it.
      for (const status of TENANT_STATUSES) {
        const outcome = decide(status, 'admin');

        expect(typeof outcome === 'boolean' || outcome instanceof ApiException).toBe(true);
      }
    });

    it('refuses `created` and `deleted` too, though the host guard answers first', () => {
      // Unreachable in the pipeline — `HostTenantGuard` answers
      // `tenant_not_found` for both — and defended anyway, because "unreachable"
      // is a property of the guard in front of it rather than of this one.
      expect(decide('created', 'admin')).toBeInstanceOf(ApiException);
      expect(decide('deleted', 'admin')).toBeInstanceOf(ApiException);
    });
  });
});
