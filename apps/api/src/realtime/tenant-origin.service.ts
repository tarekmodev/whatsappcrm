import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';

/**
 * The absolute origin a relayed attachment URL is built against.
 *
 * ## Why a socket cannot use "the request's origin"
 *
 * `message_attachments.url` is stored as a path (`/api/v1/media/{id}/content`)
 * precisely so the host is supplied at the response boundary — the same row is
 * served through a tenant's platform subdomain and through its custom domain
 * (TAR-29). On the HTTP path the request supplies it. A socket has no request:
 * the only host-shaped things on an upgrade are `Host` and `Origin`, both
 * client-controlled, and a relay that built a URL from them would let a client
 * choose where its neighbours' media appeared to live.
 *
 * So the origin comes from the control plane, on `TenantLinkService`'s reasoning
 * for invite and reset links — the tenant's primary *verified* domain, read
 * through `TenantPrisma` so RLS decides which rows exist. An unverified custom
 * domain is skipped for the same reason `HostTenantGuard` refuses to resolve
 * one: the row exists while DNS and TLS are still being proved.
 *
 * That query is a near-copy of `TenantLinkService.primaryHostname`, and
 * deliberately not extracted yet — two call sites in two different layers is not
 * evidence of a shape, and a shared "tenant hostname" service that one of them
 * has to bend to fit is the worse outcome. A third caller is the point at which
 * to pull it out.
 *
 * ## Why it is not cached
 *
 * It looks like a hot-path read and is not. It is consulted only when a message
 * being relayed carries an attachment whose bytes are already stored, and an
 * inbound attachment is `pending` with a null `url` at `message.created` time —
 * the download runs off the ingest path. So the common event relays without
 * touching this at all. A cache here would buy little and would hold a tenant's
 * old hostname for its TTL after a domain change, which is the more expensive
 * failure of the two.
 */
@Injectable()
export class TenantOriginService {
  private readonly logger = new Logger(TenantOriginService.name);
  private readonly scheme: string;

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    config: ConfigService,
  ) {
    this.scheme = config.getOrThrow<string>('APP_LINK_SCHEME');
  }

  /**
   * `https://{primary verified host}` for the tenant in scope, or `null` when it
   * has no verified domain.
   *
   * `null` is a real state rather than an error: every tenant is issued a
   * platform subdomain at provisioning, so a tenant without one is a broken
   * provisioning, and the caller's answer is to publish no URL rather than to
   * invent a host.
   */
  async originForTenantInScope(): Promise<string | null> {
    const domain = await this.prisma.tenantDomain.findFirst({
      where: { verifiedAt: { not: null } },
      select: { hostname: true },
      // Primary first; then the platform subdomain, which is issued by us and
      // verified at provisioning, ahead of any custom domain.
      orderBy: [{ isPrimary: 'desc' }, { kind: 'asc' }, { createdAt: 'asc' }],
    });

    if (domain === null) {
      this.logger.warn(
        'Relaying a message for a tenant with no verified domain: attachment URLs will be null.',
      );
      return null;
    }

    return `${this.scheme}://${domain.hostname}`;
  }
}
