import { Injectable } from '@nestjs/common';
import type { SessionPrincipal } from '@whatsappcrm/contracts';
import type { Request } from 'express';
import type { PrincipalSource } from '../rbac/principal.source';
import { sessionTokenFrom } from './session-cookie';
import { SessionService } from './session.service';

/**
 * The real principal source: the session cookie, resolved against the tenant
 * the request host established.
 *
 * This is the binding `RbacModule` was built around — TAR-22 stubbed *the
 * source*, never the guard, so `PrincipalGuard`, `PermissionGuard` and the
 * visibility predicate all run identically before and after this file exists.
 * Swapping the supplier is the whole change.
 *
 * `tenantId` is a parameter rather than something read out of the request,
 * which is the property worth protecting: it comes from `HostTenantGuard` — DNS
 * and a TLS certificate — not from anything the caller can set. A source that
 * derived the tenant from the credential instead would let a replayed session
 * choose its own tenant, and `SessionService.resolve` reinforces that by
 * looking the row up under RLS, where a cookie from another tenant simply
 * matches nothing.
 *
 * Returns `null` for every rejection. Throwing is reserved for a misconfigured
 * deployment, so "nobody is signed in" and "this build is broken" stay
 * distinguishable in the logs.
 */
@Injectable()
export class SessionPrincipalSource implements PrincipalSource {
  constructor(private readonly sessions: SessionService) {}

  async resolve(request: Request, tenantId: string): Promise<SessionPrincipal | null> {
    const token = sessionTokenFrom(request);

    if (token === null) {
      return null;
    }

    return await this.sessions.resolve(token, tenantId);
  }
}
