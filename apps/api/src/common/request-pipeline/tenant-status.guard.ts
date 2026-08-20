import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TENANT_STATUS_EFFECTS } from '@whatsappcrm/contracts';
import type { ApiException } from '../errors/api.exception';
import { tenantInactive } from '../errors/tenant-inactive';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { isAvailableWhileSuspended, isPlatformRoute, isPublicRoute } from './route-access';

/**
 * Stage 4 of the request pipeline: **may this principal reach this route right
 * now, given the state its tenant is in** (ADR 0002 stage 4, ADR 0009
 * decision 2, TAR-36).
 *
 * ## Two gates, and this is the one that knows who is asking
 *
 * `assert_tenant_serviceable` in the database answers a different question —
 * does this tenant's data exist and is it intact — and admits `trialing`,
 * `active`, `past_due`, `suspended` and `cancelled`. It has to admit `suspended`,
 * because a suspended tenant's inbound WhatsApp messages must still be stored
 * and the ingest path writes them through `TenantPrisma` under row-level
 * security; refusing there would push the highest-volume write in the product
 * onto the unscoped client.
 *
 * The consequence, and ADR 0009 Amendment 1 ruling 1 states it as one: **this
 * guard is now the only thing between a suspended tenant's agent and the API.**
 * So it is default-deny, and `@AvailableWhileSuspended()` on an admin-reachable
 * route is the sole exemption. There is no path list here, and no wildcard.
 *
 * ## The table it implements
 *
 * | Status      | Agent / supervisor | Admin                   |
 * | ----------- | ------------------ | ----------------------- |
 * | `trialing`  | full               | full                    |
 * | `active`    | full               | full                    |
 * | `past_due`  | full               | full                    |
 * | `suspended` | refused            | recovery allowlist only |
 * | `cancelled` | refused            | recovery allowlist only |
 *
 * `created` and `deleted` are absent because they are unreachable:
 * `HostTenantGuard` answers `tenant_not_found` for both before this runs.
 *
 * `past_due` is deliberately full access for everyone. Dunning is a banner, not
 * an outage, and `TENANT_STATUS_EFFECTS.past_due.apiAccess` has said so since the
 * contract was published — which is where this guard reads the answer from,
 * rather than restating a second copy of the table that could drift from it.
 *
 * ## What it skips, and why login is not here
 *
 * `@PlatformRoute()` and `@PublicPlatformRoute()` skip it: there is no tenant
 * resolved and no principal to judge. `@Public()` skips it too, and that is the
 * subtle one — login is `@Public()`, and ADR 0009 is explicit that a suspended
 * tenant's login must run the **entire** authentication flow first and only then
 * refuse by role. Checking the status here, before a password has been verified,
 * would turn the endpoint into a role oracle: an unauthenticated caller could
 * learn per address whether it belongs to an admin by watching which of two
 * errors came back. That check therefore lives in `AuthService.login`, after the
 * principal is resolved.
 *
 * ## Order
 *
 * After `PrincipalGuard`, because it needs a role; before `PermissionGuard`,
 * because "your workspace is suspended" is a truer answer than "you lack
 * `ticket:write`" and because the two would otherwise race to explain the same
 * refusal. `request-pipeline.module.ts` is where that order is declared and
 * `request-pipeline.http.spec.ts` is where it is asserted.
 */
@Injectable()
export class TenantStatusGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (isPlatformRoute(this.reflector, context) || isPublicRoute(this.reflector, context)) {
      return true;
    }

    const status = this.tenantContext.tenantStatus;

    if (status === null) {
      // Not a caller error: it means this guard was mounted without
      // `HostTenantGuard` in front of it. Fail closed and loudly, as
      // `PrincipalGuard` does for the same mistake.
      throw new Error(
        'TenantStatusGuard ran with no tenant status in scope. It must be declared after HostTenantGuard.',
      );
    }

    if (TENANT_STATUS_EFFECTS[status].apiAccess) {
      return true;
    }

    if (this.isRecoveringAdmin(context)) {
      return true;
    }

    throw refusal();
  }

  /**
   * The one exemption: an **admin**, on a route that declared itself part of the
   * recovery allowlist.
   *
   * Both halves are required. The decorator alone would open the route to every
   * agent in a suspended tenant, which is precisely TAR-36's fourth acceptance
   * criterion inverted; the role alone would give an admin the whole product
   * back, which is not a suspension.
   *
   * The role is read off the principal `PrincipalGuard` resolved, so it is the
   * session's role rather than anything the request carried.
   */
  private isRecoveringAdmin(context: ExecutionContext): boolean {
    if (!isAvailableWhileSuspended(this.reflector, context)) {
      return false;
    }

    return this.tenantContext.principal?.role === 'admin';
  }
}

/**
 * One code and one message, shared with every other place this condition is
 * raised (TAR-539).
 *
 * `subscription_inactive` is what `identity.http.ts` has answered since TAR-51
 * and what the console already maps to its workspace-inactive screen, so a
 * refusal here lands in a path the frontend has had for a while rather than in a
 * new one.
 *
 * **`tenantInactive()` rather than copy of this guard's own**, which is a
 * deliberate reversal: an earlier revision distinguished `suspended` from
 * `cancelled` and added "an administrator can still sign in to restore it".
 * TAR-539 landed while this was in review and normalised the same refusal across
 * ten translators, saying in as many words that the guard at the edge and the
 * data-layer fallback behind it must "say the same thing". Two messages for one
 * condition is the drift that helper exists to remove, and a caller cannot tell
 * which layer answered — so the shared one wins.
 *
 * What is given up is a sentence of product copy, not information a caller is
 * owed: which of the two states a workspace is in, and when it purges, are on
 * `GET /tenant/lifecycle`, which is on the recovery allowlist precisely so an
 * admin can read them. Nothing here names who suspended the tenant or why —
 * `reason` is operator free text, and a refusal an agent sees is not where it
 * gets rendered.
 */
function refusal(): ApiException {
  return tenantInactive();
}
