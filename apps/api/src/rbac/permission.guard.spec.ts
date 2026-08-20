import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  permissionsForRole,
  type Permission,
  type SessionPrincipal,
  type TenantRole,
} from '@whatsappcrm/contracts';
import { ApiException } from '../common/errors/api.exception';
import { PlatformRoute, Public } from '../common/request-pipeline/route-access';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PermissionGuard } from './permission.guard';
import { AnyPrincipal, RequirePermission } from './require-permission.decorator';

/**
 * The matrix, enforced. These construct principals directly rather than going
 * through the interim stub, which is the point: what is asserted here is the
 * real enforcement path and survives TAR-35 unchanged.
 */
function principalFor(role: TenantRole): SessionPrincipal {
  return {
    userId: '0192f0ff-0000-7000-8000-00000000a001',
    tenantId: '0192f0ff-0000-7000-8000-0000000000b1',
    email: `${role}@example.invalid`,
    displayName: role,
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [],
    sessionId: '0192f0ff-0000-7000-8000-0000000000ff',
    expiresAt: '2026-12-31T23:59:59.000Z',
  };
}

/** A context whose handler carries whatever the decorator would have set. */
function contextFor(handler: () => void): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => class TestController {},
  } as unknown as ExecutionContext;
}

function handlerRequiring(...permissions: readonly Permission[]): () => void {
  const handler = (): void => undefined;

  RequirePermission(...permissions)({}, 'handler', { value: handler });

  return handler;
}

describe('PermissionGuard', () => {
  const tenantContext = new TenantContextService();
  const guard = new PermissionGuard(new Reflector(), tenantContext);

  function activateAs(role: TenantRole, handler: () => void): boolean {
    return tenantContext.run(
      {
        requestId: 'req_permission_guard',
        tenantId: null,
        userId: null,
        principal: null,
      },
      () => {
        tenantContext.setPrincipal(principalFor(role));
        return guard.canActivate(contextFor(handler));
      },
    );
  }

  function refusalFor(role: TenantRole, handler: () => void): ApiException {
    try {
      activateAs(role, handler);
    } catch (error) {
      return error as ApiException;
    }

    throw new Error('expected the guard to refuse');
  }

  it('admits a principal holding the permission', () => {
    expect(activateAs('agent', handlerRequiring('conversation:read'))).toBe(true);
    expect(activateAs('supervisor', handlerRequiring('user:update'))).toBe(true);
    expect(activateAs('admin', handlerRequiring('billing:manage'))).toBe(true);
  });

  it('refuses an agent the tenant-admin surface — TAR-22 AC1', () => {
    for (const permission of ['tenant:settings', 'user:invite', 'billing:read'] as const) {
      const failure = refusalFor('agent', handlerRequiring(permission));

      expect(failure).toBeInstanceOf(ApiException);
      expect(failure.code).toBe('forbidden');
      expect(failure.getStatus()).toBe(403);
    }
  });

  it('refuses a supervisor the admin-only permissions', () => {
    // `workflow:write` left this list under TAR-27. 0004 made it admin-only
    // because a workflow "can send messages autonomously"; 0009's security
    // section rules that the reason is right about the risk it names and does
    // not apply to the launch action set — every action a supervisor can arm is
    // one they can already perform by hand — and moves the gate to a separate
    // `workflow:send_message` for whoever adds the first customer-facing
    // action. See the case below.
    for (const permission of ['user:set_role', 'user:remove', 'billing:manage'] as const) {
      expect(refusalFor('supervisor', handlerRequiring(permission)).code).toBe('forbidden');
    }
  });

  it('admits a supervisor the workflow builder — TAR-27', () => {
    for (const permission of ['workflow:read', 'workflow:write'] as const) {
      expect(activateAs('supervisor', handlerRequiring(permission))).toBe(true);
    }

    // Still refused to an agent: the console's automation surface is a
    // supervisor-and-above one, and it writes to tickets without anybody
    // watching.
    expect(refusalFor('agent', handlerRequiring('workflow:read')).code).toBe('forbidden');
  });

  it('requires every permission when a route names more than one', () => {
    // The `PATCH /users/{id}` shape: `user:update` alone is not enough when the
    // body carries a role.
    const handler = handlerRequiring('user:update', 'user:set_role');

    expect(refusalFor('supervisor', handler).code).toBe('forbidden');
    expect(activateAs('admin', handler)).toBe(true);
  });

  it('names the permissions that were missing, and nothing else', () => {
    const failure = refusalFor('agent', handlerRequiring('user:update', 'user:set_role'));

    expect(failure.message).toContain('user:update');
    expect(failure.message).toContain('user:set_role');
    // Never the caller's own role or id — the message is read by the client.
    expect(failure.message).not.toContain('agent@example.invalid');
  });

  it('admits every role on a route that deliberately needs no permission', () => {
    const handler = (): void => undefined;
    AnyPrincipal()({}, 'handler', { value: handler });

    for (const role of ['agent', 'supervisor', 'admin'] as const) {
      expect({ role, admitted: activateAs(role, handler) }).toEqual({ role, admitted: true });
    }
  });

  // The property that matters most: a route added later without a decorator is
  // refused, not admitted. The alternative makes every future route one
  // forgotten line away from being open, and the line is invisible in review.
  it('refuses a route that declares no permission at all', () => {
    expect(() => activateAs('admin', () => undefined)).toThrow(/no @RequirePermission/);
  });

  it('refuses to run at all without a principal in scope', () => {
    expect(() =>
      tenantContext.run(
        { requestId: 'req_none', tenantId: 'tenant_a', userId: null, principal: null },
        () => guard.canActivate(contextFor(handlerRequiring('user:read'))),
      ),
    ).toThrow(/must be declared after PrincipalGuard/);
  });

  /**
   * The two exemptions the global installation needs (TAR-58). Both are routes
   * `PrincipalGuard` also skipped, so there is no caller to check — without
   * this, every login and every health probe would be a 500 from the branch
   * above rather than a response.
   */
  describe('the route-access exemptions', () => {
    function activateExempt(decorate: (target: object) => void): boolean {
      class ExemptController {}
      decorate(ExemptController);

      const context = {
        getHandler: () => (): void => undefined,
        getClass: () => ExemptController,
      } as unknown as ExecutionContext;

      return tenantContext.run(
        { requestId: 'req_exempt', tenantId: null, userId: null, principal: null },
        () => guard.canActivate(context),
      );
    }

    it.each([
      ['@Public()', Public],
      ['@PlatformRoute()', PlatformRoute],
    ])('admits a %s route with no permission and no principal', (_label, decorator) => {
      expect(activateExempt(decorator() as (target: object) => void)).toBe(true);
    });
  });
});
