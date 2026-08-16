import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseFilters,
} from '@nestjs/common';
import {
  CustomFieldDefinitionCreateInputSchema,
  CustomFieldDefinitionReorderInputSchema,
  CustomFieldDefinitionUpdateInputSchema,
  IdSchema,
  type CustomFieldDefinition,
  type CustomFieldDefinitionCreateInput,
  type CustomFieldDefinitionListResponse,
  type CustomFieldDefinitionReorderInput,
  type CustomFieldDefinitionUpdateInput,
} from '@whatsappcrm/contracts';
import { z } from 'zod';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CustomFieldsService } from './custom-fields.service';
import { translateContactFailure } from './contacts.http';

/** `{id}` on the two addressed routes. Validated, so a non-UUID is a 400 and not a query. */
const CustomFieldParamsSchema = z.object({ id: IdSchema });

/**
 * The tenant's contact schema (TAR-33, 0002 amendment 10): the five routes that
 * let an admin define what fields a contact has.
 *
 * **`/custom-fields`, not `/custom-field-defs`.** The console and its mock
 * transport have read the former since TAR-289, and `-defs` is an abbreviation
 * of a table name leaking into a public path. A *value* is never addressable on
 * its own, so there is nothing to disambiguate from.
 *
 * **`tenant:settings` to mutate, `contact:read` to list.** That split is this
 * story's first acceptance criterion, and it is why the write half is not
 * `contact:write`: every agent holds that one, so carrying definition writes on
 * it would let any agent redefine the tenant's contact record. `tenant:settings`
 * is already in `PERMISSIONS` and in no role list but admin's, so `rbac.ts` is
 * unchanged. Reads are `contact:read` because every agent has to render the
 * fields to fill them in, and a definition list is labels and option lists —
 * never a contact's data.
 *
 * There is deliberately no `GET /{id}`: the list *is* the resource, and a client
 * that has it has the row.
 */
@Controller({ path: 'custom-fields', version: '1' })
@UseFilters(ApiExceptionFilter)
export class CustomFieldsController {
  constructor(private readonly customFields: CustomFieldsService) {}

  /** `GET /api/v1/custom-fields` — the whole vocabulary, in display order. */
  @Get()
  @RequirePermission('contact:read')
  list(): Promise<CustomFieldDefinitionListResponse> {
    return this.customFields.list();
  }

  /**
   * Before `PATCH :id` and `DELETE :id`, because Nest matches routes in
   * declaration order and `reorder` would otherwise be read as an id — and
   * `IdSchema` would then answer `validation_failed` for a route that exists.
   */
  @Post('reorder')
  @RequirePermission('tenant:settings')
  @HttpCode(HttpStatus.OK)
  reorder(
    @Body(new ZodValidationPipe(CustomFieldDefinitionReorderInputSchema))
    input: CustomFieldDefinitionReorderInput,
  ): Promise<CustomFieldDefinitionListResponse> {
    return this.customFields.reorder(input).catch(translateContactFailure);
  }

  @Post()
  @RequirePermission('tenant:settings')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(CustomFieldDefinitionCreateInputSchema))
    input: CustomFieldDefinitionCreateInput,
  ): Promise<CustomFieldDefinition> {
    return this.customFields.create(input).catch(translateContactFailure);
  }

  /**
   * `label` and `options` only. `key` and `type` are immutable and the schema is
   * what refuses them — renaming a key orphans every stored value and silently
   * stops every routing rule naming it from matching. Both are
   * delete-and-recreate.
   */
  @Patch(':id')
  @RequirePermission('tenant:settings')
  update(
    @Param(new ZodValidationPipe(CustomFieldParamsSchema)) params: { id: string },
    @Body(new ZodValidationPipe(CustomFieldDefinitionUpdateInputSchema))
    input: CustomFieldDefinitionUpdateInput,
  ): Promise<CustomFieldDefinition> {
    return this.customFields.update(params.id, input).catch(translateContactFailure);
  }

  /**
   * `204`, and it strips that key's values from every contact in the same
   * transaction. Refused with `conflict` when a routing rule names the key.
   */
  @Delete(':id')
  @RequirePermission('tenant:settings')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param(new ZodValidationPipe(CustomFieldParamsSchema)) params: { id: string },
  ): Promise<void> {
    return this.customFields.delete(params.id).catch(translateContactFailure);
  }
}
