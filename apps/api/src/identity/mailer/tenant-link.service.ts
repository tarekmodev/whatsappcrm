import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TENANT_PRISMA, type TenantPrisma } from '../../prisma/prisma.tokens';

/**
 * Builds the absolute link that goes in an invite or reset email.
 *
 * Two properties, and both are the reason this is a service rather than a
 * template string at the call site:
 *
 *   * **The host comes from the control plane, not from the request.** It is the
 *     tenant's primary *verified* domain, read here. Taking it from the request
 *     `Host` would let an attacker who can reach the reset endpoint aim a
 *     genuine email — carrying a live token — at a host they control (TAR-53,
 *     link shapes).
 *   * **The token travels in the URL fragment.** Browsers never send a fragment
 *     to a server, so the token stays out of every access log, proxy log and
 *     `Referer` header between the recipient's browser and the API. The cost is
 *     that the reset page must be client-rendered and must clear the fragment
 *     after reading it, which is TAR-61's to implement.
 *
 * Read through `TenantPrisma`, so the lookup is bounded by the tenant already in
 * scope and RLS decides which rows exist — the resolver cannot be pointed at
 * another tenant's domain by any argument it is given.
 */
@Injectable()
export class TenantLinkService {
  private readonly scheme: string;

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    config: ConfigService,
  ) {
    this.scheme = config.getOrThrow<string>('APP_LINK_SCHEME');
  }

  /**
   * `https://{primary host}{linkPath}#token={token}`, or `null` when the tenant
   * has no verified domain — which means there is nowhere legitimate to send
   * the recipient, and a caller must not invent one.
   */
  async absoluteLink(linkPath: string, token: string): Promise<string | null> {
    const hostname = await this.primaryHostname();

    if (hostname === null) {
      return null;
    }

    return `${this.scheme}://${hostname}${linkPath}#token=${encodeURIComponent(token)}`;
  }

  /**
   * The primary verified domain, falling back to the oldest verified one.
   *
   * An unverified custom domain is skipped for the same reason `HostTenantGuard`
   * refuses to resolve one: the row exists while DNS and TLS are still being
   * proved, and mailing a live token to a hostname nobody has demonstrated
   * control of is worse than not mailing it at all.
   */
  private async primaryHostname(): Promise<string | null> {
    const domain = await this.prisma.tenantDomain.findFirst({
      where: { verifiedAt: { not: null } },
      select: { hostname: true },
      // Primary first; then the platform subdomain, which is issued by us and
      // verified at provisioning, ahead of any custom domain.
      orderBy: [{ isPrimary: 'desc' }, { kind: 'asc' }, { createdAt: 'asc' }],
    });

    return domain?.hostname ?? null;
  }
}
