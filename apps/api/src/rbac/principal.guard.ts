import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiException } from '../common/errors/api.exception';
import { pathWithoutQuery } from '../common/http-path';
import { isPlatformRoute, isPublicRoute } from '../common/request-pipeline/route-access';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { AppLoggerService } from '../observability/app-logger.service';
import { PRINCIPAL_SOURCE, type PrincipalSource, type ReplayedSession } from './principal.source';

/** The event name an alert rule and a log query both match on. */
const TENANT_MISMATCH_EVENT = 'auth.tenant_mismatch';

/**
 * Resolves **who** is calling, and publishes them for the rest of the request
 * (TAR-39, request pipeline slot 3).
 *
 * Runs after `HostTenantGuard`, which is the whole point of the ordering: the
 * tenant is established from the host first, and the caller is then checked
 * against it. A session that belongs to another tenant is answered
 * `tenant_mismatch` rather than `forbidden`, because it is a security event
 * worth alerting on rather than an ordinary permission failure.
 *
 * Installed globally by `RequestPipelineModule` since TAR-58: it is on for every
 * route, and `@Public()` or `@PlatformRoute()` is the only way past it. Neither
 * leaves a principal behind, which is why `PermissionGuard` skips the same two —
 * a route cannot be checked against a caller who was never resolved.
 *
 * It authenticates and nothing else. What the caller may *do* is
 * `PermissionGuard`'s decision, and what they can *see* is the visibility
 * predicate's plus RLS. Three separate answers, three separate places.
 */
@Injectable()
export class PrincipalGuard implements CanActivate {
  private readonly fallbackLogger = new Logger(PrincipalGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(PRINCIPAL_SOURCE) private readonly principals: PrincipalSource,
    private readonly tenantContext: TenantContextService,
    /**
     * Optional for the same reason `configureApp` treats it as optional: a
     * controller spec assembles a narrow testing module and would otherwise have
     * to import logging to test something unrelated. Never absent in the
     * application, where `ObservabilityModule` is global — and the fallback is
     * Nest's own `Logger`, which *is* this service at runtime, so the event is
     * written either way and only its shape degrades.
     */
    @Optional() private readonly logger?: AppLoggerService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPlatformRoute(this.reflector, context) || isPublicRoute(this.reflector, context)) {
      return true;
    }

    const tenantId = this.tenantContext.tenantId;

    if (tenantId === null) {
      // Not a caller error: it means this guard was mounted without
      // `HostTenantGuard` in front of it. Fail closed and loudly.
      throw new Error(
        'PrincipalGuard ran with no tenant in scope. It must be declared after HostTenantGuard.',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const resolution = await this.principals.resolve(request, tenantId);

    if (resolution.outcome === 'anonymous') {
      throw new ApiException('unauthenticated', 'This request requires a signed-in user.');
    }

    if (resolution.outcome === 'replayed') {
      this.refuseReplay(resolution.session, tenantId, request);
    }

    const { principal } = resolution;

    // Belt and braces on top of the source's own scoping: a source that resolved
    // without RLS underneath it — the interim role stub, or anything a later
    // story binds — must not be able to publish a caller from another tenant.
    if (principal.tenantId !== tenantId) {
      this.refuseReplay(
        { sessionId: principal.sessionId, tenantId: principal.tenantId, userId: principal.userId },
        tenantId,
        request,
      );
    }

    this.tenantContext.setPrincipal(principal);

    return true;
  }

  /**
   * The cross-tenant attempt, refused and recorded (TAR-58 AC2; TAR-53,
   * decision 2).
   *
   * **A log line, not an `audit_logs` row**, and that is a decision rather than
   * an omission. `audit_logs` is tenant-scoped with `FORCE ROW LEVEL SECURITY`
   * and a `WITH CHECK` on the tenant in scope — which here is the *host's*
   * tenant, while the row would have to carry the *session's*. The insert would
   * be refused, the rejection path would throw, and the 401 this exists to
   * report would become a 500. Beyond that, the path is reachable by any
   * unauthenticated caller presenting any cookie, so a row per attempt would
   * hand an anonymous attacker unbounded growth in the table auditors read.
   *
   * The fields are the ones an investigation needs and nothing more. `requestId`
   * arrives from the logger's own mixin; the token and its hash appear here and
   * in the response never.
   *
   * A counter — `auth_tenant_mismatch_total`, unlabelled so the cardinality
   * cannot be inflated from outside — is the other half of TAR-53's design and
   * waits on TAR-41 landing somewhere to put a metric.
   */
  private refuseReplay(session: ReplayedSession, hostTenantId: string, request: Request): never {
    const fields = {
      event: TENANT_MISMATCH_EVENT,
      hostTenantId,
      sessionTenantId: session.tenantId,
      sessionId: session.sessionId,
      userId: session.userId,
      ip: request.ip ?? null,
      method: request.method,
      // Stripped, because a reset or invite token travels in a query string and
      // this line is written exactly when somebody is doing something they
      // should not be.
      path: pathWithoutQuery(request.originalUrl),
    };

    if (this.logger) {
      this.logger.structured(PrincipalGuard.name).warn(fields, 'session replayed across tenants');
    } else {
      this.fallbackLogger.warn(`${TENANT_MISMATCH_EVENT} ${JSON.stringify(fields)}`);
    }

    throw new ApiException(
      'tenant_mismatch',
      'This session does not belong to the tenant served at this address.',
    );
  }
}
