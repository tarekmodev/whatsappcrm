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
 *     tenant's primary *deliverable* domain — verified, and attached at the edge
 *     if it is a custom one — read here. Taking it from the request
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
  /** Where a message that belongs to no tenant points. See `platformLink`. */
  private readonly platformDomain: string;

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    config: ConfigService,
  ) {
    this.scheme = config.getOrThrow<string>('APP_LINK_SCHEME');
    this.platformDomain = config.getOrThrow<string>('PLATFORM_DOMAIN');
  }

  /**
   * `https://{primary host}{linkPath}#token={token}`, or `null` when the tenant
   * has no deliverable domain — which means there is nowhere legitimate to send
   * the recipient, and a caller must not invent one.
   */
  async absoluteLink(linkPath: string, token: string): Promise<string | null> {
    const hostname = await this.primaryHostname();

    if (hostname === null) {
      return null;
    }

    return this.linkTo(hostname, linkPath, token);
  }

  /**
   * The same link on the **platform** host, for a message that belongs to no
   * tenant — today only self-signup's verification mail (TAR-405).
   *
   * There is no tenant to look a hostname up for: the whole point of the message
   * is that clicking it is what creates one. So the host comes from configuration
   * rather than from the control plane, which keeps the rule that matters intact
   * — the host is never taken from the request, where an attacker could set it
   * and aim a live token at a server they own.
   *
   * Not `async`, unlike its sibling, because there is nothing to read.
   */
  platformLink(linkPath: string, token: string): string {
    return this.linkTo(this.platformDomain, linkPath, token);
  }

  /**
   * The token travels in the fragment, and `encodeURIComponent` is what keeps a
   * token containing a `#` or `&` from truncating the link.
   */
  private linkTo(hostname: string, linkPath: string, token: string): string {
    return `${this.scheme}://${hostname}${linkPath}#token=${encodeURIComponent(token)}`;
  }

  /**
   * The primary **deliverable** domain, falling back to the oldest deliverable
   * one. Two conditions, and they refuse for different reasons:
   *
   *   * **Unverified** is skipped for the same reason `HostTenantGuard` refuses
   *     to resolve one: the row exists while DNS and TLS are still being proved,
   *     and mailing a live token to a hostname nobody has demonstrated control
   *     of is worse than not mailing it at all.
   *   * **Verified but not activated** is skipped because the hostname has no
   *     route and no certificate until an operator attaches it at the edge
   *     (TAR-419). A link mailed there does not bounce — it sends, and the
   *     recipient meets a certificate error or a dead host, so nobody in the
   *     tenant can accept an invitation or reset a password. `activated_at`
   *     belongs to custom domains only; the platform subdomain is served by the
   *     same edge as every other tenant's and never carries one.
   *
   * Belt and braces, deliberately (TAR-534): `TenantDomainsService.setPrimary()`
   * refuses to promote an unactivated domain and `AdminDomainsService` hands
   * primary back when one is detached, so this filter should never be what saves
   * a link. It is here because the cost of being wrong is a live token aimed at
   * an unreachable host, and every future path that clears `activated_at` would
   * otherwise have to remember the invariant on its own.
   */
  private async primaryHostname(): Promise<string | null> {
    const domain = await this.prisma.tenantDomain.findFirst({
      where: {
        verifiedAt: { not: null },
        OR: [{ kind: 'platform' }, { activatedAt: { not: null } }],
      },
      select: { hostname: true },
      // Primary first; then the platform subdomain, which is issued by us and
      // verified at provisioning, ahead of any custom domain.
      orderBy: [{ isPrimary: 'desc' }, { kind: 'asc' }, { createdAt: 'asc' }],
    });

    return domain?.hostname ?? null;
  }
}
