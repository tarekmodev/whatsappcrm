import { Controller, Get, Query, UseFilters } from '@nestjs/common';
import {
  MessageTemplateListQuerySchema,
  type MessageTemplateListQuery,
  type MessageTemplatePage,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { isTenantNotActiveError, tenantInactive } from '../common/errors/tenant-inactive';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { InvalidCursorError } from './message-template-cursor';
import {
  MessageTemplateQueryService,
  UnknownWhatsAppAccountError,
} from './message-template-query.service';
import { toMessageTemplateResponse } from './message-template.response';

/**
 * `GET /api/v1/message-templates` — the approved templates an agent may send.
 *
 * ## Where this endpoint comes from
 *
 * It is not in TAR-39's fixed stage-1 endpoint list. It is added under the same
 * conventions — `/api/v1`, plural kebab-case noun, cursor pagination,
 * `{ items, nextCursor }`, a Zod contract in `packages/contracts` — because the
 * composer needs it: the moment the 24-hour service window closes, a template is
 * the only thing an agent can send, and the picker has to be populated from
 * somewhere. The shape is ruled in amendment 1 of
 * `docs/architecture/0002-architecture-and-api-contract.md`: filter by phone
 * number, order by name, and publish the three fields derived from Meta's
 * component tree.
 *
 * ## Authentication and permission
 *
 * Closed by `RequestPipelineModule` (TAR-58), like every other route: host →
 * tenant, cookie → principal, then the permission below. Until that landed this
 * controller stood on a hand-written `requireTenant()` check, which kept
 * anonymous callers out but enforced no permission at all — the exact gap the
 * global pipeline exists to make impossible to ship again.
 *
 * `conversation:send` is the permission its own comment named for this route
 * before there was a guard to enforce it, and it is the right one: a template is
 * only useful to someone who may send, and the picker is part of the composer.
 */
@Controller({ path: 'message-templates', version: '1' })
@UseFilters(ApiExceptionFilter)
export class MessageTemplatesController {
  constructor(private readonly templates: MessageTemplateQueryService) {}

  @Get()
  @RequirePermission('conversation:send')
  async list(
    @Query(new ZodValidationPipe(MessageTemplateListQuerySchema)) query: MessageTemplateListQuery,
  ): Promise<MessageTemplatePage> {
    const page = await this.templates
      .list({
        limit: query.limit,
        cursor: query.cursor,
        whatsappAccountId: query.whatsappAccountId,
        whatsappBusinessAccountId: query.whatsappBusinessAccountId,
        q: query.q,
      })
      .catch((error: unknown) => translateQueryFailure(error));

    return { items: page.items.map(toMessageTemplateResponse), nextCursor: page.nextCursor };
  }
}

function translateQueryFailure(error: unknown): never {
  if (error instanceof InvalidCursorError) {
    throw new ApiException('validation_failed', error.message, [
      { path: 'cursor', message: error.message },
    ]);
  }

  if (error instanceof UnknownWhatsAppAccountError) {
    throw new ApiException('validation_failed', error.message, [
      { path: 'whatsappAccountId', message: error.message },
    ]);
  }

  if (isTenantNotActiveError(error)) {
    // A deactivated tenant with a session still open. A legitimate runtime state
    // an operator created, not a fault — reporting it as 500 would page someone
    // every time a tenant was shut off. The error's own message names the data
    // layer and the tenant id, so it never becomes the body (TAR-539).
    throw tenantInactive();
  }

  throw error;
}
