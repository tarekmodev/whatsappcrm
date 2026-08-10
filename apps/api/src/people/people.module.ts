import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { HostTenantGuard } from '../tenancy/host-tenant.guard';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * People and teams (TAR-22). The bounded context is "who works here and how
 * they are grouped" — not authentication, which is TAR-35's, and not the
 * permission vocabulary, which is `RbacModule`'s.
 *
 * `HostTenantGuard` is declared here because `TenancyModule` keeps its own
 * providers private and this is the first consumer outside it; the guard is
 * stateless and holds no per-module state, so a second instance costs nothing.
 * `PrincipalGuard`, `PermissionGuard` and `SessionRevocationService` come from
 * the global `RbacModule`, and `AuditService` from the global `AuditModule`.
 *
 * Both services are exported: TAR-35's invite-acceptance flow and TAR-36's
 * graduation path drive them rather than reimplementing the invariants.
 */
@Module({
  controllers: [UsersController, TeamsController],
  providers: [UsersService, TeamsService, HostTenantGuard, ApiExceptionFilter],
  exports: [UsersService, TeamsService],
})
export class PeopleModule {}
