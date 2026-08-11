import {
  Inject,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiException } from '../common/errors/api.exception';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PRINCIPAL_SOURCE, type PrincipalSource } from './principal.source';

/**
 * Resolves **who** is calling, and publishes them for the rest of the request
 * (TAR-39, request pipeline slot 3).
 *
 * Runs after `HostTenantGuard`, which is the whole point of the ordering: the
 * tenant is established from the host first, and the caller is then checked
 * against it. A principal whose own tenant disagrees is a session being replayed
 * against another tenant's domain — answered `tenant_mismatch` rather than
 * `forbidden`, because it is a security event worth alerting on rather than an
 * ordinary permission failure.
 *
 * It authenticates and nothing else. What the caller may *do* is
 * `PermissionGuard`'s decision, and what they can *see* is the visibility
 * predicate's plus RLS. Three separate answers, three separate places.
 */
@Injectable()
export class PrincipalGuard implements CanActivate {
  private readonly logger = new Logger(PrincipalGuard.name);

  constructor(
    @Inject(PRINCIPAL_SOURCE) private readonly principals: PrincipalSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const tenantId = this.tenantContext.tenantId;

    if (tenantId === null) {
      // Not a caller error: it means this guard was mounted without
      // `HostTenantGuard` in front of it. Fail closed and loudly.
      throw new Error(
        'PrincipalGuard ran with no tenant in scope. It must be declared after HostTenantGuard.',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const principal = await this.principals.resolve(request, tenantId);

    if (principal === null) {
      throw new ApiException('unauthenticated', 'This request requires a signed-in user.');
    }

    if (principal.tenantId !== tenantId) {
      this.logger.warn(
        `Refused a session for tenant ${principal.tenantId} presented at the host of tenant ${tenantId}.`,
      );
      throw new ApiException(
        'tenant_mismatch',
        'This session does not belong to the tenant served at this address.',
      );
    }

    this.tenantContext.setPrincipal(principal);

    return true;
  }
}
