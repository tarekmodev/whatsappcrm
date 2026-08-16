import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';

/**
 * Contact tags (TAR-33). A bounded context of its own rather than a folder
 * inside `ContactsModule`, because a tag is a taxonomy several subjects read:
 * the contact profile and the contact-list filter here, the routing-rule
 * condition builder in `AssignmentModule` (0007), workflow references in TAR-27,
 * and `ticket_tags` next.
 *
 * `TagsService` is exported for the same reason `PeopleModule` exports its two:
 * a consumer that needs the tenant's tags should drive this service rather than
 * reimplementing the case-insensitive-name invariant. The *reference check*
 * `ContactsService` needs is a plain function in `tag-references.ts` instead,
 * because it has to run inside the caller's transaction — a provider cannot be
 * handed one.
 *
 * No guards are declared: since TAR-58 the three that protect this controller
 * are installed application-wide by `RequestPipelineModule`. Everything else
 * comes from global modules — `TenantPrisma` from `PrismaModule`,
 * `TenantContextService` from `TenantContextModule`.
 */
@Module({
  controllers: [TagsController],
  providers: [TagsService, ApiExceptionFilter],
  exports: [TagsService],
})
export class TagsModule {}
