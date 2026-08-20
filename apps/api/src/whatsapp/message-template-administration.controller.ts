import { Controller, Get, Query, UseFilters } from '@nestjs/common';
import {
  MessageTemplateAdminListQuerySchema,
  type MessageTemplateAdminListQuery,
  type MessageTemplateAdminPage,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { isTenantNotActiveError, tenantInactive } from '../common/errors/tenant-inactive';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { MessageTemplateAdministrationService } from './message-template-administration.service';
import { InvalidCursorError } from './message-template-cursor';
import { toMessageTemplateAdminResponse } from './message-template.response';

/**
 * `GET /api/v1/whatsapp/message-templates` — every WhatsApp template connected
 * to this tenant, with its Meta status and, when an agent cannot send it, why
 * (TAR-91; ruled in 0002 amendment 8).
 *
 * ## What this exists for
 *
 * Amendment 1 accepts two silent exclusions on the composer's picker — templates
 * Meta has not approved, and templates whose buttons need a send-time parameter
 * — and justifies both on one promise: "the template-administration surface
 * under `channel:manage` shows every template with its status, so this is
 * visible to the tenant, not silently missing." Until this route existed that
 * promise was prose. A template an agent cannot find had nowhere in the product
 * that explained it.
 *
 * So the response answers the question a picker cannot: not "here is what you
 * may send" but "here is everything you have, and here is what is standing in
 * the way of each one" — `sendBlockers` distinguishing *Meta has not approved
 * this* from *we cannot send this yet*, which are different problems with
 * different owners.
 *
 * ## Authentication and permission
 *
 * The ordinary request pipeline, and deliberately nothing else:
 * `HostTenantGuard` resolves the tenant from the host, `PrincipalGuard` the
 * session, and `PermissionGuard` refuses anyone without `channel:manage` before
 * this handler exists. Tenant-facing, so it never names its own tenant in the
 * path (0002, decision 2) — a caller cannot reach a neighbour's templates
 * because there is no place in this contract to ask for one, and RLS would
 * refuse it if there were.
 *
 * `channel:manage` rather than `conversation:send`: this is the WhatsApp
 * channel's configuration, sitting under the same permission as the WABA
 * connection it belongs to. An agent who may send does not thereby need to see a
 * rejected template.
 *
 * ## Why the path is under `whatsapp/`
 *
 * Not a query parameter on `GET /api/v1/message-templates`. That route's
 * approved-and-sendable filter is fixed with nothing that can reach past it,
 * precisely so a picker cannot offer a send that fails at Meta; a parameter that
 * relaxed it would put the two surfaces one query string apart. Separate paths
 * mean neither can be turned into the other by accident, and `whatsapp/` is
 * already where this tenant's channel configuration lives
 * (`POST /api/v1/whatsapp/business-accounts`).
 */
@Controller({ path: 'whatsapp/message-templates', version: '1' })
@UseFilters(ApiExceptionFilter)
export class MessageTemplateAdministrationController {
  constructor(private readonly templates: MessageTemplateAdministrationService) {}

  @Get()
  @RequirePermission('channel:manage')
  async list(
    @Query(new ZodValidationPipe(MessageTemplateAdminListQuerySchema))
    query: MessageTemplateAdminListQuery,
  ): Promise<MessageTemplateAdminPage> {
    const page = await this.templates
      .list({
        limit: query.limit,
        cursor: query.cursor,
        whatsappBusinessAccountId: query.whatsappBusinessAccountId,
        status: query.status,
        q: query.q,
      })
      .catch((error: unknown) => translateQueryFailure(error));

    return { items: page.items.map(toMessageTemplateAdminResponse), nextCursor: page.nextCursor };
  }
}

function translateQueryFailure(error: unknown): never {
  if (error instanceof InvalidCursorError) {
    throw new ApiException('validation_failed', error.message, [
      { path: 'cursor', message: error.message },
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
