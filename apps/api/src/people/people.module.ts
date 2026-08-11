import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * People and teams (TAR-22). The bounded context is "who works here and how
 * they are grouped" — not authentication, which is TAR-35's, and not the
 * permission vocabulary, which is `RbacModule`'s.
 *
 * No guards are declared. Since TAR-58 the three that protect these controllers
 * are installed application-wide by `RequestPipelineModule`; this module used to
 * carry its own `HostTenantGuard` instance for `@UseGuards`, and that is exactly
 * the per-module wiring the global registration removed.
 * `SessionRevocationService` comes from the global `RbacModule`, and
 * `AuditService` from the global `AuditModule`.
 *
 * Both services are exported: TAR-35's invite-acceptance flow and TAR-36's
 * graduation path drive them rather than reimplementing the invariants.
 */
@Module({
  controllers: [UsersController, TeamsController],
  providers: [UsersService, TeamsService, ApiExceptionFilter],
  exports: [UsersService, TeamsService],
})
export class PeopleModule {}
