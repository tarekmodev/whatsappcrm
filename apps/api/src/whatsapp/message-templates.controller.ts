import { Controller, Get, Query, UseFilters } from '@nestjs/common';
import {
  MessageTemplateListQuerySchema,
  type MessageTemplateListQuery,
  type MessageTemplatePage,
  type MessageTemplateResponse,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  InvalidCursorError,
  MessageTemplateQueryService,
  UnknownWhatsAppAccountError,
  type ListedTemplate,
} from './message-template-query.service';

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

    return { items: page.items.map(toResponse), nextCursor: page.nextCursor };
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

  if (error instanceof TenantNotActiveError) {
    // A deactivated tenant with a session still open. A legitimate runtime state
    // an operator created, not a fault — reporting it as 500 would page someone
    // every time a tenant was shut off. TAR-41's global filter takes this over.
    throw new ApiException('forbidden', error.message);
  }

  throw error;
}

/**
 * Maps the row onto the published response. Explicit rather than spread, so
 * adding a column to the projection cannot quietly add a field to the API.
 *
 * `components` is Prisma's `JsonValue`, which includes `null` for a SQL NULL —
 * the contract publishes `unknown | null`, so the two already agree and this is
 * a pass-through rather than a conversion. `bodyText`, `parameterCount` and
 * `headerFormat` are read out of that same tree here (0002, amendment 1): the
 * composer needs to know how many variable inputs to render without shipping its
 * own parser for Meta's shape, and the send path needs the arity to check
 * against before it calls Meta.
 */
function toResponse({ row, summary }: ListedTemplate): MessageTemplateResponse {
  return {
    id: row.id,
    whatsappBusinessAccountId: row.whatsappBusinessAccountId,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    components: row.components,
    bodyText: summary.bodyText,
    parameterCount: summary.parameterCount,
    headerFormat: summary.headerFormat,
    headerParameterCount: summary.headerParameterCount,
    // `false` for every row this endpoint returns, by construction — the page
    // drops the rest. Published anyway, because the administration surface that
    // has to explain "approved by Meta, not yet sendable from this product"
    // cannot say it about a template it cannot identify.
    requiresButtonParameters: summary.requiresButtonParameters,
    providerTemplateId: row.providerTemplateId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
