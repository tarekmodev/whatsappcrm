import {
  Inject,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiException } from '../common/errors/api.exception';
import { isPlatformRoute } from '../common/request-pipeline/route-access';
import { matchesSharedSecret } from '../common/security/shared-secret';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Env } from '../config/env.schema';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';

/** The host the web tier says the request arrived at. Read only behind the header below. */
const FORWARDED_HOST_HEADER = 'x-forwarded-host';

/** The shared secret that makes the header above worth reading. */
const EDGE_AUTH_HEADER = 'x-edge-auth';

/**
 * Express 5 has already stripped the port from `req.hostname`; a forwarded host
 * carries whatever the browser sent, so `acme.app.localhost:3000` has to lose its
 * port here to match a `tenant_domains` row.
 */
const PORT_SUFFIX = /:\d+$/;

/**
 * Resolves **which tenant** a request is for, from the host it arrived on, and
 * puts it in scope (TAR-39, request pipeline slot 2).
 *
 * Installed globally by `RequestPipelineModule` since TAR-58, so it runs on
 * every route. `@PlatformRoute()` is the only way past it, and it is the only
 * decorator in the codebase that removes tenant resolution outright.
 *
 * The host, never the caller. A tenant id taken from a header, a body field or
 * a token claim is a tenant id an attacker can choose; a hostname is chosen by
 * DNS and by the TLS certificate in front of it. `PrincipalGuard` then refuses
 * any principal whose own tenant disagrees with this one, so a stolen session
 * replayed at another tenant's domain fails on the mismatch rather than being
 * served.
 *
 * ## The forwarded host, and the secret that makes it a host rather than a claim
 *
 * Render routes by `Host` at its edge, and tenant domains are attached to the
 * **web** service — so inside the API `request.hostname` is always the API's own
 * host, on the browser path through the Next.js rewrite as much as on the SSR
 * path. Left as it was, this guard resolved nothing in any deployed environment
 * (TAR-64 blocker; TAR-148 is the decision that fixes it).
 *
 * So the web tier forwards the host it was reached at, and proves it is the web
 * tier by presenting a secret only it and this process hold: `x-forwarded-host`
 * is read **only** when `x-edge-auth` matches `TRUSTED_PROXY_SECRET` (or the
 * previous one, so the secret can rotate without a synchronised two-service
 * deploy). Without that proof the header is not read at all — the fallback is
 * `Host`, exactly as before, never the value the caller supplied.
 *
 * Express `trust proxy` stays off, deliberately. Turning it on would make
 * `req.hostname` honour `X-Forwarded-Host` *ungated*, which is precisely the
 * spoof this guard exists to prevent; the gate has to be explicit code here, not
 * a framework-wide flag.
 *
 * A leaked secret lets its holder name any *verified* tenant hostname. On an
 * authenticated route `PrincipalGuard` still cross-checks the session's tenant
 * and answers `tenant_mismatch`, so the secret alone yields no data; on a
 * `@Public()` route — login, password reset, invite lookup — there is nothing to
 * cross-check, and that residual exposure is why the secret is per environment,
 * rotatable, and never given a `NEXT_PUBLIC_` prefix on the web side.
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
export class HostTenantGuard implements CanActivate, OnModuleInit {
  private readonly logger = new Logger(HostTenantGuard.name);

  /**
   * The current and previous `TRUSTED_PROXY_SECRET`, read once at construction:
   * rotating one is a redeploy, not something a request can observe changing.
   */
  private readonly edgeSecrets: readonly string[];

  constructor(
    private readonly reflector: Reflector,
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    private readonly tenantContext: TenantContextService,
    config: ConfigService<Env, true>,
  ) {
    this.edgeSecrets = [
      config.get('TRUSTED_PROXY_SECRET', { infer: true }),
      config.get('TRUSTED_PROXY_SECRET_PREVIOUS', { infer: true }),
    ].filter((secret): secret is string => typeof secret === 'string' && secret !== '');
  }

  /**
   * One line at boot saying which side of the trust boundary this process is on.
   *
   * The flag, never the value. A missing secret does not fail a request in a way
   * anybody reads as "misconfigured" — every tenant route answers a uniform
   * `tenant_not_found`, which looks exactly like an unknown domain — so this line
   * plus a post-deploy smoke request against a real tenant host is what catches
   * the two services disagreeing.
   */
  onModuleInit(): void {
    this.logger.log(
      this.edgeSecrets.length > 0
        ? `Forwarded-host tenant resolution is enabled: a request presenting a valid ${EDGE_AUTH_HEADER} resolves its tenant from ${FORWARDED_HOST_HEADER}.`
        : `Forwarded-host tenant resolution is disabled (no TRUSTED_PROXY_SECRET): tenants resolve from the Host header only.`,
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPlatformRoute(this.reflector, context)) {
      // No tenant is left in scope, deliberately: `TenantPrisma` then refuses
      // every statement, so a platform route that reaches for tenant data fails
      // closed instead of reading whichever tenant happened to be resolved.
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const hostname = hostnameOf(request, this.edgeSecrets);

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
 * The hostname this request is for: port stripped, lowercased to match the
 * `citext` column.
 *
 * `Host` unless a trusted edge said otherwise. `req.hostname` is Express's
 * reading of `Host`; it honours `X-Forwarded-Host` only when `trust proxy` is
 * set, which it deliberately is not, so the forwarded value reaches this
 * function only through the explicit gate below.
 */
function hostnameOf(request: Request, edgeSecrets: readonly string[]): string | null {
  if (!isTrustedEdge(request, edgeSecrets)) {
    return normalisedHostname(request.hostname);
  }

  const forwarded = request.header(FORWARDED_HOST_HEADER);

  if (forwarded === undefined || forwarded.trim() === '') {
    // A trusted edge that named no host is not an attack — a probe that reached
    // the API service directly looks like this. `Host` is the honest answer, and
    // it is the same answer an untrusted caller would have got.
    return normalisedHostname(request.hostname);
  }

  if (forwarded.includes(',')) {
    // Multi-valued: either spliced by a caller upstream of the edge, or two
    // separate headers Express joined into one. Taking the leftmost element is
    // how forwarded-header splicing gets in, so this is refused outright rather
    // than resolved to whichever half looks most plausible.
    return null;
  }

  return normalisedHostname(forwarded);
}

/**
 * True when the request proves it came from the web tier by presenting a secret
 * only the two services hold.
 *
 * Fail closed on every step: no secret configured, no header, or an empty one,
 * and the forwarded host is never read. Both the current and the previous secret
 * are accepted so a rotation is three ordinary deploys rather than one
 * synchronised swap — see `TRUSTED_PROXY_SECRET_PREVIOUS` in `env.schema.ts`.
 */
function isTrustedEdge(request: Request, edgeSecrets: readonly string[]): boolean {
  const presented = request.header(EDGE_AUTH_HEADER);

  if (presented === undefined || presented === '') {
    return false;
  }

  return edgeSecrets.some((secret) => matchesSharedSecret(presented, secret));
}

/** Strips a trailing `:port`, lowercases, and reads blank as "no host at all". */
function normalisedHostname(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const hostname = value.trim().replace(PORT_SUFFIX, '').toLowerCase();

  return hostname === '' ? null : hostname;
}

/**
 * One answer for "no host", "unknown host" and "unverified host". Which of the
 * three it was would tell an unauthenticated caller whether a tenant exists at a
 * hostname, which is exactly the enumeration this avoids.
 */
function tenantNotFound(): ApiException {
  return new ApiException('tenant_not_found', 'No tenant is served at this address.');
}
