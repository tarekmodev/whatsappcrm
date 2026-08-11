import { Injectable, Logger, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { ApiException } from '../../common/errors/api.exception';
import { matchesSharedSecret } from '../../common/security/shared-secret';

const BEARER_PREFIX = 'Bearer ';

/**
 * Authenticates the **platform operator** on `/api/v1/admin/*`.
 *
 * A shared bearer token, and deliberately not a session: the operator is not a
 * user inside any tenant, so there is nothing for TAR-35's session lookup or
 * TAR-22's per-tenant roles to resolve them against. Provisioning has to work
 * before the first tenant — and therefore the first user — exists.
 *
 * Stated plainly because it matters at review time: a single shared secret has
 * no identity, no per-operator revocation and no audit trail beyond "someone
 * with the token". It is the right amount of mechanism for an
 * admin-provisioned-only product with no platform-admin identity yet, and it is
 * the thing to replace when one exists. Everything else about the endpoint —
 * validation, idempotency, isolation — is independent of how the caller is
 * authenticated.
 *
 * Two properties it does have:
 *
 *   * **Fail closed.** No `PLATFORM_ADMIN_TOKEN` configured means every request
 *     is refused. An environment that was never given a token cannot provision,
 *     rather than provisioning for anybody who asks.
 *   * **Constant time.** Both sides are hashed to a fixed 32 bytes and compared
 *     with `timingSafeEqual`, so neither the token's length nor how far a guess
 *     matched is observable. A plain `===` on an attacker-supplied string is
 *     measurable over enough requests.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  private readonly logger = new Logger(PlatformAdminGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('PLATFORM_ADMIN_TOKEN');

    if (expected === undefined || expected === '') {
      this.logger.error(
        'Refused an admin request: PLATFORM_ADMIN_TOKEN is not configured, so the ' +
          'platform admin surface is disabled in this environment.',
      );
      throw unauthenticated();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const presented = bearerTokenFrom(request.header('authorization'));

    if (presented === null || !matchesSharedSecret(presented, expected)) {
      // Logged, not returned: the caller learns only that it failed. This is
      // the platform's own control plane, so a failure here is worth alerting
      // on (TAR-41 owns wiring that up).
      this.logger.warn('Refused an admin request: missing or invalid platform admin token.');
      throw unauthenticated();
    }

    return true;
  }
}

function unauthenticated(): ApiException {
  // One message for every failure mode — absent header, wrong scheme, wrong
  // token, unconfigured environment — so the response cannot be used to work
  // out which of them it was.
  return new ApiException('unauthenticated', 'A valid platform admin token is required.');
}

function bearerTokenFrom(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }

  const token = header.slice(BEARER_PREFIX.length).trim();

  return token === '' ? null : token;
}
