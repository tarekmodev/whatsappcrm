import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import {
  ContactCreateInputSchema,
  ContactListQuerySchema,
  ContactUpdateInputSchema,
  IdSchema,
  type ContactCreateInput,
  type ContactListQuery,
  type ContactResponse,
  type ContactUpdateInput,
  type CursorPage,
} from '@whatsappcrm/contracts';
import { z } from 'zod';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { ContactsService } from './contacts.service';
import { translateContactFailure } from './contacts.http';

/** `{id}` on the two addressed routes. Validated, so a non-UUID is a 400 and not a query. */
const ContactParamsSchema = z.object({ id: IdSchema });

/**
 * The tenant's contacts (TAR-33, the four routes in 0002's endpoint table).
 *
 * It declares no guards. `RequestPipelineModule` runs all three on every route
 * in the application since TAR-58 — where the request is, who is making it, then
 * may they — so a route added later is protected whether or not anybody
 * remembers. `PermissionGuard` denies by default, so every route states its
 * permission.
 *
 * `contact:read` and `contact:write`, both granted to every role: an agent
 * working a conversation has to read and correct the customer on the other end
 * of it. What an agent may *not* do is redefine the tenant's contact record —
 * that is `tenant:settings` on `CustomFieldsController`, and the split is this
 * story's first acceptance criterion.
 *
 * There is no `DELETE`. `contact:delete` exists in the vocabulary and 0002
 * publishes no route for it: erasing a customer touches conversations, tickets
 * and the retention policy, and belongs in the story that owns those.
 */
@Controller({ path: 'contacts', version: '1' })
@UseFilters(ApiExceptionFilter)
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  /** `GET /api/v1/contacts` — the directory, with `q` search and a `tagId` filter. */
  @Get()
  @RequirePermission('contact:read')
  list(
    @Query(new ZodValidationPipe(ContactListQuerySchema)) query: ContactListQuery,
  ): Promise<CursorPage<ContactResponse>> {
    return this.contacts.list(query);
  }

  @Post()
  @RequirePermission('contact:write')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(ContactCreateInputSchema)) input: ContactCreateInput,
  ): Promise<ContactResponse> {
    return this.contacts.create(input).catch(translateContactFailure);
  }

  @Get(':id')
  @RequirePermission('contact:read')
  get(
    @Param(new ZodValidationPipe(ContactParamsSchema)) params: { id: string },
  ): Promise<ContactResponse> {
    return this.contacts.get(params.id).catch(translateContactFailure);
  }

  /**
   * `PATCH /api/v1/contacts/{id}` — identity, tags and custom field values.
   *
   * `tagIds` replaces the contact's tags, so this is also the assign-and-remove
   * route; `customFields` merges, per 0002 amendment 10.
   */
  @Patch(':id')
  @RequirePermission('contact:write')
  update(
    @Param(new ZodValidationPipe(ContactParamsSchema)) params: { id: string },
    @Body(new ZodValidationPipe(ContactUpdateInputSchema)) input: ContactUpdateInput,
  ): Promise<ContactResponse> {
    return this.contacts.update(params.id, input).catch(translateContactFailure);
  }
}
