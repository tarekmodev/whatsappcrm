import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import {
  TagCreateInputSchema,
  TagListQuerySchema,
  type CursorPage,
  type Tag,
  type TagCreateInput,
  type TagListQuery,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { TagsService } from './tags.service';
import { translateTagFailure } from './tags.http';

/**
 * The tenant's contact tags (TAR-33, the two routes in 0002's endpoint table).
 *
 * It declares no guards. `RequestPipelineModule` runs all three on every route
 * in the application since TAR-58 — where the request is, who is making it, then
 * may they — so a route added later is protected whether or not anybody
 * remembers. `PermissionGuard` denies by default, so every route states its
 * permission.
 *
 * There is deliberately no `PATCH`, `DELETE` or `GET /{id}`: 0002 publishes two
 * routes, the list *is* the resource for a set this small, and deleting a tag
 * has consequences — `workflow_references` refuses it while a workflow names one
 * — that belong in their own story rather than being invented here.
 */
@Controller({ path: 'tags', version: '1' })
@UseFilters(ApiExceptionFilter)
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  /** `GET /api/v1/tags` — the whole taxonomy, tenant-wide for every role. */
  @Get()
  @RequirePermission('contact:read')
  list(
    @Query(new ZodValidationPipe(TagListQuerySchema)) query: TagListQuery,
  ): Promise<CursorPage<Tag>> {
    return this.tags.list(query);
  }

  /** `POST /api/v1/tags` — coining a label, which any agent may do. */
  @Post()
  @RequirePermission('contact:write')
  @HttpCode(HttpStatus.CREATED)
  create(@Body(new ZodValidationPipe(TagCreateInputSchema)) input: TagCreateInput): Promise<Tag> {
    return this.tags.create(input).catch(translateTagFailure);
  }
}
