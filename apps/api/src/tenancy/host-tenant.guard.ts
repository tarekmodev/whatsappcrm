import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ApiException } from '../common/errors/api.exception';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';

/**
 * Resolves **which tenant** a request is for, from the host it arrived on, and
 * puts it in scope (TAR-39, request pipeline slot 2).
 *
 * The host, never the caller. A tenant id taken from a header, a body field or
 * a token claim is a tenant id an attacker can choose; a hostname is chosen by
 * DNS and by the TLS certificate in front of it. `PrincipalGuard` then refuses
 * any principal whose own tenant disagrees with this one, so a stolen session
 * replayed at another tenant's domain fails on the mismatch rather than being
 * served.
 *
 * ## Why `SystemPrisma`
 *
 * Chicken and egg: `TenantPrisma` refuses every statement until a tenant is in
 * scope, and this is the thing that puts one there. ADR 0002 confines the
 * unscoped client to five call sites and asks for a justification in review for
 * a sixth; this is that sixth, and it is the narrowest possible use — one
 * indexed lookup on `tenant_domains.hostname` (`citext`, unique), selecting two
 * columns, writing nothing, and never accepting anything from the caller beyond
 * the host itself.
 *
 * An unverified custom domain does not resolve (TAR-29): the row exists while
 * DNS and TLS are still being proved, and honouring it early would let a
 * customer claim a hostname they have not demonstrated control of. Platform
 * subdomains are issued by us and verified at provisioning.
 *
 * ## Not cached, deliberately, for now
 *
 * One primary-key-class lookup per request. Caching it means a revoked or
 * re-pointed domain keeps resolving for the cache's lifetime, which is a
 * tenant-routing bug with a security shape. TAR-41 brings Redis and can add a
 * short TTL with an explicit invalidation path; until there is somewhere to
 * invalidate, the query is the honest answer.
 */
@Injectable()
export class HostTenantGuard implements CanActivate {
  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    private readonly tenantContext: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const hostname = hostnameOf(request);

    if (hostname === null) {
      throw tenantNotFound();
    }

    const domain = await this.systemPrisma.tenantDomain.findFirst({
      where: { hostname, verifiedAt: { not: null } },
      select: { tenantId: true },
    });

    if (domain === null) {
      throw tenantNotFound();
    }

    // Only the tenant. The user is `PrincipalGuard`'s to add — this guard has
    // established where the request is, not who is making it.
    this.tenantContext.setTenant(domain.tenantId);

    return true;
  }
}

/**
 * The `Host` header with any port stripped, lowercased to match the `citext`
 * column.
 *
 * `req.hostname` already does this in Express 5 and honours `X-Forwarded-Host`
 * only when `trust proxy` is set — which it is not, so a client cannot pick its
 * own tenant by forging that header. When the platform sits behind a proxy that
 * rewrites `Host`, enabling `trust proxy` is a deliberate, reviewed change.
 */
function hostnameOf(request: Request): string | null {
  const hostname = request.hostname;

  return typeof hostname === 'string' && hostname !== '' ? hostname.toLowerCase() : null;
}

/**
 * One answer for "no host", "unknown host" and "unverified host". Which of the
 * three it was would tell an unauthenticated caller whether a tenant exists at a
 * hostname, which is exactly the enumeration this avoids.
 */
function tenantNotFound(): ApiException {
  return new ApiException('tenant_not_found', 'No tenant is served at this address.');
}
