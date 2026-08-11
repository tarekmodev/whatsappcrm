import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiException } from '../common/errors/api.exception';
import { isPlatformRoute } from '../common/request-pipeline/route-access';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';

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
 * ## The forwarded-host trust boundary
 *
 * "The host, never the caller" is still the rule, but in every deployed
 * environment the host this process sees is **not** the one the browser typed.
 * Render routes at its edge by `Host`, and a request only reaches the API
 * service if its `Host` names a domain attached to *that* service — tenant
 * domains (TAR-29) are attached to the web service. The browser path adds a
 * second hop: `next.config.mjs` rewrites `/api/*` to an absolute `API_BASE_URL`,
 * which sets `Host` to the API's own host. So `request.hostname` is the API host
 * on both paths, and resolves no tenant at all.
 *
 * The decision (ADR 0003, TAR-64) is to trust `x-forwarded-host` **only** when
 * the request also presents `x-edge-auth` matching a secret the API and the web
 * tier both hold. That is the same primitive `PlatformAdminGuard` uses — a
 * fail-closed, timing-safe shared bearer, hashed then compared with
 * `timingSafeEqual` — rather than a new trust mechanism.
 *
 * Three properties make it safe to read a header here at all:
 *
 *   * **Gated, and never a fallback.** No secret, a wrong secret, or an
 *     unusable forwarded value all fall back to `request.hostname` or to
 *     nothing — never to the attacker-chosen value. A misconfiguration answers
 *     `tenant_not_found` on every tenant route, which is loud and total.
 *   * **Explicit code, not `trust proxy`.** Express's `trust proxy` would make
 *     `req.hostname` honour `X-Forwarded-Host` *ungated*, which is precisely the
 *     spoof this guard exists to prevent. It stays off, permanently.
 *   * **The verified-domain requirement is unchanged.** Even holding the secret,
 *     a caller can only name a hostname that is already a verified
 *     `tenant_domains` row.
 *
 * The residual risk, stated rather than buried: a leaked secret lets its holder
 * name any verified tenant hostname. On authenticated routes `PrincipalGuard`
 * still cross-checks the session's tenant and answers `tenant_mismatch`, so the
 * secret alone yields no data; on `@Public()` routes — login, password reset,
 * invite lookup — there is no session to cross-check, so it does expose those
 * surfaces. That is why the secret is per-environment, rotatable, and never
 * shipped to a browser.
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
  private readonly logger = new Logger(HostTenantGuard.name);

  /**
   * The current secret and, during a rotation, the previous one.
   *
   * Read once at construction rather than per request: `validateEnv` has already
   * run by then, the values cannot change while the process lives, and a
   * `config.get` on the hot path of every request buys nothing.
   *
   * Both are accepted so the two services can be rolled independently — web
   * first with the new value, then the API, then drop the previous — instead of
   * needing a synchronised deploy that no platform offers.
   */
  private readonly trustedProxySecrets: readonly string[];

  constructor(
    private readonly reflector: Reflector,
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    private readonly tenantContext: TenantContextService,
    config: ConfigService,
  ) {
    this.trustedProxySecrets = [
      config.get<string>('TRUSTED_PROXY_SECRET'),
      config.get<string>('TRUSTED_PROXY_SECRET_PREVIOUS'),
    ].filter((secret): secret is string => secret !== undefined && secret !== '');

    // The flag, never the value. Whether forwarded-host trust is on is the first
    // thing anybody debugging a tenant-wide `tenant_not_found` needs to know,
    // and it is not otherwise visible from outside the process.
    this.logger.log(
      this.trustedProxySecrets.length > 0
        ? `Forwarded-host trust is enabled (${String(this.trustedProxySecrets.length)} secret(s) accepted).`
        : 'Forwarded-host trust is disabled: the tenant is resolved from the Host header alone.',
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
    const hostname = hostnameOf(request, this.trustedProxySecrets);

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

/** The header the web tier presents to prove it is the web tier. */
const EDGE_AUTH_HEADER = 'x-edge-auth';

/** The header it uses to name the host the browser actually asked for. */
const FORWARDED_HOST_HEADER = 'x-forwarded-host';

/**
 * A DNS hostname and nothing else.
 *
 * Applied to the forwarded value only. It is not an injection defence — the
 * lookup is a bound parameter — but a header is free text, and a value carrying
 * a newline or a control character reaches the log before it reaches the query.
 * `request.hostname` is Express's own parse of `Host` and is left as it was.
 */
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Which host this request is *for*, port stripped and lowercased to match the
 * `citext` column.
 *
 * Two sources, and the choice between them is the trust boundary:
 *
 *   1. `x-forwarded-host`, but **only** when `x-edge-auth` matches a configured
 *      secret. That is our own web tier telling us what the browser asked for.
 *   2. `request.hostname` otherwise — Express's parse of `Host`, which honours
 *      `X-Forwarded-Host` only under `trust proxy`, which is off.
 *
 * There is deliberately no third case. Once the gate opens, an absent,
 * multi-valued or malformed forwarded value answers `null` rather than falling
 * back to `request.hostname`: a caller that authenticated as the edge and then
 * sent a host we cannot read is a misconfiguration, and resolving it from the
 * API's own host would only produce a confusing near-miss.
 *
 * A comma is rejected outright rather than split on. Leftmost-wins is how
 * forwarded-header splicing gets in — an attacker appends a value the edge did
 * not write, and a parser that takes an element gets the attacker's.
 */
function hostnameOf(request: Request, trustedProxySecrets: readonly string[]): string | null {
  if (!presentsTrustedEdgeAuth(request, trustedProxySecrets)) {
    const hostname = request.hostname;

    return typeof hostname === 'string' && hostname !== '' ? hostname.toLowerCase() : null;
  }

  return forwardedHostOf(request.headers[FORWARDED_HOST_HEADER]);
}

/**
 * Whether the request carries a secret we issued.
 *
 * `false` for every doubt: no secret configured, no header, an array of them
 * (Node exposes repeated headers that way, and two values mean two claimants),
 * or a value that does not match. The comparison itself reuses
 * `PlatformAdminGuard`'s shape — hash both sides to a fixed 32 bytes, then
 * `timingSafeEqual` — so neither the secret's length nor how far a guess matched
 * is measurable.
 */
function presentsTrustedEdgeAuth(
  request: Request,
  trustedProxySecrets: readonly string[],
): boolean {
  if (trustedProxySecrets.length === 0) {
    return false;
  }

  const presented = request.headers[EDGE_AUTH_HEADER];

  if (typeof presented !== 'string' || presented === '') {
    return false;
  }

  // Every secret is compared, without a short circuit on the first match: which
  // of the two accepted values matched is not something a caller should be able
  // to time during a rotation.
  return trustedProxySecrets.reduce(
    (matched, secret) => timingSafeEqual(sha256(presented), sha256(secret)) || matched,
    false,
  );
}

function forwardedHostOf(header: string | string[] | undefined): string | null {
  // An array is Node's rendering of the header sent twice; a comma is it sent
  // once with two values spliced in. Both mean more than one claimed host.
  if (typeof header !== 'string' || header.includes(',')) {
    return null;
  }

  const hostname = stripPort(header.trim()).toLowerCase();

  return HOSTNAME_PATTERN.test(hostname) ? hostname : null;
}

/** `acme.example:3000` → `acme.example`. Bracketed IPv6 literals keep their brackets. */
function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');

    return end === -1 ? host : host.slice(0, end + 1);
  }

  const colon = host.indexOf(':');

  return colon === -1 ? host : host.slice(0, colon);
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * One answer for "no host", "unknown host" and "unverified host". Which of the
 * three it was would tell an unauthenticated caller whether a tenant exists at a
 * hostname, which is exactly the enumeration this avoids.
 */
function tenantNotFound(): ApiException {
  return new ApiException('tenant_not_found', 'No tenant is served at this address.');
}
