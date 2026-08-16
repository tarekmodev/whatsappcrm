import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { CustomFieldsController } from './custom-fields.controller';
import { CustomFieldsService } from './custom-fields.service';

/**
 * Contacts and the tenant's contact schema (TAR-33). The bounded context is "who
 * the customers are and what a tenant records about them".
 *
 * Custom field definitions live here rather than in a module of their own
 * because they *are* the shape of a contact: the definition list and the value
 * map are two halves of one resource, and splitting them would put the merge
 * rules and the definitions they validate against on either side of a module
 * boundary. Tags are the opposite case and are their own module — several
 * subjects read that taxonomy, not only contacts.
 *
 * It imports `TagsModule` for nothing: the tag reference check
 * `ContactsService` needs runs inside its own write transaction, which a
 * provider cannot be handed, so it is the plain function in
 * `tags/tag-references.ts`. Everything else comes from global modules —
 * `TenantPrisma` from `PrismaModule`, `TenantContextService` from
 * `TenantContextModule`, `AuditService` from `AuditModule`.
 *
 * `ContactsService` is exported so a later story that creates a contact from an
 * inbound message drives the invariants here rather than reimplementing them.
 * `conversations/conversation.mapper.ts` imports this module's `contact.mapper`
 * directly — a file import of a pure function, not a Nest dependency, and the
 * move that put it here is what stops the inbox and the profile disagreeing
 * about the same person.
 *
 * No guards are declared: since TAR-58 the three that protect these controllers
 * are installed application-wide by `RequestPipelineModule`.
 */
@Module({
  controllers: [ContactsController, CustomFieldsController],
  providers: [ContactsService, CustomFieldsService, ApiExceptionFilter],
  exports: [ContactsService, CustomFieldsService],
})
export class ContactsModule {}
