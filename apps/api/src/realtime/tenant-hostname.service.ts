import { Inject, Injectable, Logger } from '@nestjs/common';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';

/**
 * The hostname a relayed payload may name back to this API.
 *
 * ## Why a socket cannot use "the host this request came in on"
 *
 * `ResponseOriginService` builds an origin from `tenantContext.hostname`, which
 * `HostTenantGuard` records from `Host` — or from the forwarded-host header a
 * trusted edge presented (TAR-148). Its own doc says it refuses to answer for "a
 * queue worker, a socket relay before it has a handshake", and that refusal is
 * right: a WebSocket upgrade carries `Host` and `Origin` and nothing else, both
 * client-controlled, and a relay that built a URL from them would let a client
 * choose where its neighbours' media appeared to live. There is also no request
 * at all behind a relay — the event comes off the in-process bus, from a webhook
 * that arrived on a completely different connection.
 *
 * So the hostname comes from the control plane instead, on `TenantLinkService`'s
 * reasoning for invite and reset links: the tenant's primary **verified**
 * domain, read through `TenantPrisma` so RLS decides which rows exist. An
 * unverified custom domain is skipped for the same reason `HostTenantGuard`
 * refuses to resolve one — the row exists while DNS and TLS are still being
 * proved.
 *
 * The query is a near-copy of `TenantLinkService.primaryHostname`, and
 * deliberately not extracted yet: two call sites in two different layers is not
 * evidence of a shape, and a shared "tenant hostname" service that one of them
 * has to bend to fit is the worse outcome. A third caller is the point at which
 * to pull it out.
 *
 * ## It publishes into the scope rather than returning a string
 *
 * The relay then calls `ResponseOriginService` like every other caller, so the
 * scheme and the origin's shape are decided in exactly one place. Returning an
 * origin from here instead would be a second implementation of the two lines
 * that matter, in the one module whose payloads nobody sees in a browser's
 * address bar — which is where a difference would go unnoticed longest.
 *
 * ## Why it is not cached
 *
 * One indexed read per relayed message, against a table with a handful of rows
 * per tenant. A cache would hold a tenant's old hostname for its TTL after a
 * domain change, which is the more expensive failure of the two — and if this
 * ever shows up in a profile, the answer is a cache shared with
 * `HostTenantGuard`, which does the same lookup on every single request.
 */
@Injectable()
export class TenantHostnameService {
  private readonly logger = new Logger(TenantHostnameService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Puts the tenant-in-scope's primary verified hostname into the scope, and
   * says whether there was one.
   *
   * `false` is a real state rather than an error, and it costs nothing real: a
   * tenant with no verified domain has no host `HostTenantGuard` would resolve,
   * so nobody can be signed in to it and it has no sockets for a relay to reach.
   * The caller drops the event; publishing a payload whose attachment URLs named
   * an invented host would be the worse answer.
   */
  async publish(): Promise<boolean> {
    const domain = await this.prisma.tenantDomain.findFirst({
      where: { verifiedAt: { not: null } },
      select: { hostname: true },
      // Primary first; then the platform subdomain, which is issued by us and
      // verified at provisioning, ahead of any custom domain.
      orderBy: [{ isPrimary: 'desc' }, { kind: 'asc' }, { createdAt: 'asc' }],
    });

    if (domain === null) {
      this.logger.warn(
        `Tenant ${this.tenantContext.tenantId ?? 'unknown'} has no verified domain; ` +
          'dropping a realtime event rather than publishing URLs against an invented host.',
      );
      return false;
    }

    this.tenantContext.setHostname(domain.hostname);

    return true;
  }
}
