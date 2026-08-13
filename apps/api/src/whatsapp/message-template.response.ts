import type { MessageTemplateAdminResponse, MessageTemplateResponse } from '@whatsappcrm/contracts';
import { messageTemplateSendBlockers } from './message-template-sendability';
import type { ListedTemplate } from './message-template.projection';

/**
 * The one mapper from a template row onto a published response, in both shapes
 * the API offers.
 *
 * Explicit rather than spread, so adding a column to the projection cannot
 * quietly add a field to the API. `components` is Prisma's `JsonValue`, which
 * includes `null` for a SQL NULL — the contract publishes `unknown | null`, so
 * the two already agree and this is a pass-through rather than a conversion.
 *
 * `bodyText`, `parameterCount` and the two header fields are read out of that
 * same tree (0002, amendment 1): the composer needs to know how many variable
 * inputs to render without shipping its own parser for Meta's shape, and the
 * send path needs the arity to check against before it calls Meta.
 */
export function toMessageTemplateResponse({
  row,
  summary,
}: ListedTemplate): MessageTemplateResponse {
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
    // `false` for every row `GET /api/v1/message-templates` returns, by
    // construction — that page drops the rest. Published anyway, because the
    // administration surface that has to explain "approved by Meta, not yet
    // sendable from this product" cannot say it about a template it cannot
    // identify.
    requiresButtonParameters: summary.requiresButtonParameters,
    providerTemplateId: row.providerTemplateId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The same row for `GET /api/v1/whatsapp/message-templates` (TAR-91), plus the
 * two fields that surface exists for.
 *
 * Built on the mapper above rather than beside it, for the reason
 * `MessageTemplateAdminResponseSchema` extends its base: a template must not
 * describe itself differently depending on which list it was read through, and
 * two mappers is how that starts.
 *
 * `sendable` is computed from the blockers rather than in parallel with them, so
 * the invariant the contract refines on — `sendable` means exactly "no blockers"
 * — holds by construction here instead of being asserted after the fact.
 */
export function toMessageTemplateAdminResponse(
  listed: ListedTemplate,
): MessageTemplateAdminResponse {
  const sendBlockers = messageTemplateSendBlockers(listed.row.status, listed.summary);

  return {
    ...toMessageTemplateResponse(listed),
    sendable: sendBlockers.length === 0,
    sendBlockers,
  };
}
