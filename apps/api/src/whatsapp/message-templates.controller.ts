import { Controller, Get, Query, UseFilters } from '@nestjs/common';
import {
  MessageTemplateListQuerySchema,
  type MessageTemplateListQuery,
  type MessageTemplatePage,
  type MessageTemplateResponse,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import {
  InvalidCursorError,
  MessageTemplateQueryService,
  type ListedMessageTemplate,
} from './message-template-query.service';

/**
 * `GET /api/v1/message-templates` — the approved templates an agent may send.
 *
 * ## Where this endpoint comes from
 *
 * It is not in TAR-39's fixed stage-1 endpoint list. It is added here under the
 * same conventions — `/api/v1`, plural kebab-case noun, cursor pagination,
 * `{ items, nextCursor }`, a Zod contract in `packages/contracts` — because the
 * composer needs it: the moment the 24-hour service window closes, a template is
 * the only thing an agent can send, and the picker has to be populated from
 * somewhere.
 *
 * ## Authentication and permission — read this before adding a second route
 *
 * The published pipeline puts `AuthGuard` (TAR-35) and `PermissionGuard`
 * (TAR-22) in front of every tenant-facing route, and **neither exists yet**.
 * Until they do, this handler refuses any request that reaches it without a
 * tenant in scope, which today is every request: the tenant-context middleware
 * opens the scope with `tenantId: null` and nothing fills it in.
 *
 * That is a deliberate fail-closed placeholder, not an oversight, and it is
 * worth being precise about what it does and does not give:
 *
 *   * It **does** guarantee this route cannot serve one tenant's templates to
 *     another, or to an anonymous caller. There is no code path from an
 *     unauthenticated request to a row.
 *   * It **does not** enforce `conversation:send`. When TAR-22 lands, this
 *     controller gets `@RequirePermission('conversation:send')` and nothing else
 *     changes — the permission is named here so that step is a decoration, not a
 *     decision to re-take.
 */
@Controller({ path: 'message-templates', version: '1' })
@UseFilters(ApiExceptionFilter)
export class MessageTemplatesController {
  constructor(
    private readonly templates: MessageTemplateQueryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(MessageTemplateListQuerySchema)) query: MessageTemplateListQuery,
  ): Promise<MessageTemplatePage> {
    this.requireTenant();

    const page = await this.templates
      .list({
        limit: query.limit,
        cursor: query.cursor,
        whatsappBusinessAccountId: query.whatsappBusinessAccountId,
      })
      .catch((error: unknown) => translateQueryFailure(error));

    return { items: page.items.map(toResponse), nextCursor: page.nextCursor };
  }

  /**
   * Stands in for `AuthGuard` until TAR-35 lands. `TenantPrisma` would refuse
   * the query anyway — `MissingTenantContextError`, fail-closed — but that
   * surfaces as a 500, which tells a caller a server fault occurred when the
   * truth is that they are not authenticated.
   */
  private requireTenant(): void {
    if (this.tenantContext.tenantId === null) {
      throw new ApiException(
        'unauthenticated',
        'This endpoint requires an authenticated tenant session.',
      );
    }
  }
}

function translateQueryFailure(error: unknown): never {
  if (error instanceof InvalidCursorError) {
    throw new ApiException('validation_failed', error.message, [
      { path: 'cursor', message: error.message },
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
 * a pass-through rather than a conversion.
 */
function toResponse(template: ListedMessageTemplate): MessageTemplateResponse {
  return {
    id: template.id,
    whatsappBusinessAccountId: template.whatsappBusinessAccountId,
    name: template.name,
    language: template.language,
    category: template.category,
    status: template.status,
    components: template.components,
    providerTemplateId: template.providerTemplateId,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}
