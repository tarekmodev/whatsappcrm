import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import {
  CreateKnowledgeDocumentInputSchema,
  KnowledgeDocumentListQuerySchema,
  UpdateKnowledgeDocumentInputSchema,
  type CreateKnowledgeDocumentInput,
  type CursorPage,
  type KnowledgeDocumentListItem,
  type KnowledgeDocumentListQuery,
  type KnowledgeDocumentResponse,
  type UpdateKnowledgeDocumentInput,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { translateAiFailure } from './ai.http';
import { KnowledgeDocumentService } from './knowledge-document.service';

/**
 * The tenant's knowledge base (TAR-28, 0010's endpoint surface).
 *
 * It declares no guards. `RequestPipelineModule` runs all three on every route
 * in the application — where the request is, who is making it, then whether they
 * may — so every route below states only its permission.
 *
 * `ai:read` and `ai:write` already exist in the shipped matrix and are
 * admin-only. This story adds no permission and moves no grant: knowledge-base
 * content is tenant-authored business material, and widening the grant to agents
 * is 0004's call rather than this implementation's.
 *
 * **A content-changing write answers with `status: 'pending'`.** Indexing runs
 * off the request, so the document is not retrievable by the bot until the job
 * commits — the console renders the pending state, which is the honest thing to
 * show and why `chunkCount` is on the response.
 *
 * No `Idempotency-Key` on the create. 0002 requires the header on sends and
 * billing operations; a duplicate knowledge-base document is a visible, editable
 * row an admin can delete, not a message a customer received twice.
 */
@Controller({ path: 'knowledge-documents', version: '1' })
@UseFilters(ApiExceptionFilter)
export class KnowledgeDocumentsController {
  constructor(private readonly documents: KnowledgeDocumentService) {}

  @Get()
  @RequirePermission('ai:read')
  list(
    @Query(new ZodValidationPipe(KnowledgeDocumentListQuerySchema))
    query: KnowledgeDocumentListQuery,
  ): Promise<CursorPage<KnowledgeDocumentListItem>> {
    return this.documents.list(query).catch(translateAiFailure);
  }

  @Get(':id')
  @RequirePermission('ai:read')
  get(@Param('id', documentIdPipe()) id: string): Promise<KnowledgeDocumentResponse> {
    return this.documents.get(id).catch(translateAiFailure);
  }

  @Post()
  @RequirePermission('ai:write')
  create(
    @Body(new ZodValidationPipe(CreateKnowledgeDocumentInputSchema))
    input: CreateKnowledgeDocumentInput,
  ): Promise<KnowledgeDocumentResponse> {
    return this.documents.create(input).catch(translateAiFailure);
  }

  @Patch(':id')
  @RequirePermission('ai:write')
  update(
    @Param('id', documentIdPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateKnowledgeDocumentInputSchema))
    input: UpdateKnowledgeDocumentInput,
  ): Promise<KnowledgeDocumentResponse> {
    return this.documents.update(id, input).catch(translateAiFailure);
  }

  /**
   * `202`, because the work has been accepted rather than done: the response
   * says `pending` and the chunks appear when the job commits.
   */
  @Post(':id/reindex')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('ai:write')
  reindex(@Param('id', documentIdPipe()) id: string): Promise<KnowledgeDocumentResponse> {
    return this.documents.reindex(id).catch(translateAiFailure);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('ai:write')
  remove(@Param('id', documentIdPipe()) id: string): Promise<void> {
    return this.documents.delete(id).catch(translateAiFailure);
  }
}

/**
 * A path parameter that is not a UUID names nothing, and it reaches a `@db.Uuid`
 * column as a driver error rather than a filter — a 500 for input that deserves
 * a 400.
 */
function documentIdPipe(): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      new ApiException('validation_failed', 'The knowledge document id must be a UUID.', [
        { path: 'id', message: 'Must be a UUID.' },
      ]),
  });
}
