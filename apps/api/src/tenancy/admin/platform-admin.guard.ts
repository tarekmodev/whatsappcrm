import { Injectable, Logger, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { ApiException } from '../../common/errors/api.exception';
import {
  parsePlatformAdminCredentials,
  type PlatformAdminCredential,
} from '../../common/security/platform-admin-credentials';
import { matchesSharedSecret } from '../../common/security/shared-secret';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';

const BEARER_PREFIX = 'Bearer ';

/**
 * Authenticates the **platform operator** on `/api/v1/admin/*`.
 *
 * A shared bearer token, and deliberately not a session: the operator is not a
 * user inside any tenant, so there is nothing for TAR-35's session lookup or
 * TAR-22's per-tenant roles to resolve them against. Provisioning has to work
 * before the first tenant — and therefore the first user — exists.
 *
 * Since TAR-166 the credential is **named**. `PLATFORM_ADMIN_TOKEN` holds a set
 * of `label:secret` entries rather than one bare secret, and the label of the
 * one that matched is published on the request scope, where `AuditService`
 * writes it to `audit_logs.actor_label`. That closes the gap this comment used
 * to state as an accepted limitation: an operator action is now attributable to
 * a credential, and revoking one operator is deleting one entry rather than
 * rotating everybody. What it still is not is an identity with a session,
 * per-route authorisation or a directory behind it — every entry is authorised
 * for every tenant, and that is the thing to replace when a real platform-admin
 * identity exists.
 *
 * Three properties it has:
 *
 *   * **Fail closed.** No `PLATFORM_ADMIN_TOKEN` configured means every request
 *     is refused. An environment that was never given a token cannot provision,
 *     rather than provisioning for anybody who asks. A *malformed* one — an
 *     unlabelled value, a short secret, a repeated label — fails the boot
 *     instead, in `env.schema.ts` and again here, because it is a mistake rather
 *     than a decision.
 *   * **Constant time.** Both sides are hashed to a fixed 32 bytes and compared
 *     with `timingSafeEqual`, so neither the token's length nor how far a guess
 *     matched is observable. A plain `===` on an attacker-supplied string is
 *     measurable over enough requests.
 *   * **No early exit.** Every configured entry is compared on every request,
 *     including after one has matched. Stopping at the match would make the
 *     response time a function of an entry's position in the list — enough, over
 *     many requests, to learn how many credentials exist and roughly where in
 *     the set a guess landed.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  private readonly logger = new Logger(PlatformAdminGuard.name);

  /**
   * Parsed once. The guard is a singleton and the value cannot change without a
   * restart, so re-parsing per request would buy nothing — and a malformed value
   * throwing here is what refuses the boot rather than the first admin request.
   */
  private readonly credentials: readonly PlatformAdminCredential[];

  constructor(
    private readonly config: ConfigService,
    private readonly tenantContext: TenantContextService,
  ) {
    this.credentials = parsePlatformAdminCredentials(
      this.config.get<string>('PLATFORM_ADMIN_TOKEN'),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.credentials.length === 0) {
      this.logger.error(
        'Refused an admin request: PLATFORM_ADMIN_TOKEN is not configured, so the ' +
          'platform admin surface is disabled in this environment.',
      );
      throw unauthenticated();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const presented = bearerTokenFrom(request.header('authorization'));
    const label = presented === null ? null : this.labelMatching(presented);

    if (label === null) {
      // Logged, not returned: the caller learns only that it failed. This is
      // the platform's own control plane, so a failure here is worth alerting
      // on (TAR-41 owns wiring that up).
      this.logger.warn('Refused an admin request: missing or invalid platform admin token.');
      throw unauthenticated();
    }

    // Published before the handler runs, so everything downstream — including
    // the audit row a connection writes inside its own transaction — can name
    // the operator without being passed it.
    this.tenantContext.setPlatformActor(label);

    return true;
  }

  /**
   * The label of the entry `presented` matches, or null.
   *
   * The loop runs to the end on purpose — see the class comment. The assignment
   * is the only thing that varies with the outcome, and it is a pointer write
   * against a SHA-256 and a `timingSafeEqual` per entry.
   */
  private labelMatching(presented: string): string | null {
    let matched: string | null = null;

    for (const credential of this.credentials) {
      if (matchesSharedSecret(presented, credential.secret)) {
        matched = credential.label;
      }
    }

    return matched;
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
