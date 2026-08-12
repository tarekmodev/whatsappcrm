import { ConversationListQuerySchema, IdSchema } from '@whatsappcrm/contracts';
import type { ConversationStatusFilter, InboxScope } from '@/lib/routes';

/**
 * The inbox's URL state, narrowed from untrusted query parameters.
 *
 * Every value is validated against the *contract's* own schema rather than cast,
 * so the console and the API agree on what a scope, a status and an id are — and
 * a hand-edited URL falls back to the default view instead of reaching a fetch
 * as a malformed query.
 *
 * Extracted from the page so the page stays composition-only and so this is
 * testable without rendering a route.
 */

export interface InboxParams {
  scope: InboxScope;
  status: ConversationStatusFilter | undefined;
  /** `null` when no thread is open, or when the parameter names no valid id. */
  conversationId: string | null;
  /** The search term, or `undefined` for an unfiltered list. */
  q: string | undefined;
}

export function parseInboxParams(raw: {
  scope: string | undefined;
  status: string | undefined;
  conversationId: string | undefined;
  q: string | undefined;
}): InboxParams {
  return {
    scope: parseScope(raw.scope),
    status: parseStatus(raw.status),
    conversationId: parseConversationId(raw.conversationId),
    q: parseQuery(raw.q),
  };
}

/**
 * The search term, bounded by the contract's own schema — a 400-character `?q=`
 * is answered 422 by the API, and dropping it is a better answer than an error
 * card for a URL somebody truncated or a browser autofilled.
 */
function parseQuery(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = ConversationListQuerySchema.shape.q.safeParse(value.trim());

  return parsed.success ? parsed.data : undefined;
}

function parseScope(value: string | undefined): InboxScope {
  const parsed = ConversationListQuerySchema.shape.scope.safeParse(value);

  return parsed.success ? parsed.data : 'assigned';
}

function parseStatus(value: string | undefined): ConversationStatusFilter | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = ConversationListQuerySchema.shape.status.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

/**
 * A conversation id, or `null`.
 *
 * Shape-checked here rather than passed through: the API answers 422 for a path
 * parameter that is not a UUID, and an error card is the wrong answer for a
 * truncated link. Whether the id names a thread this principal may see is the
 * API's to decide, and it answers `not_found` — never `forbidden`.
 */
function parseConversationId(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  return IdSchema.safeParse(value).success ? value : null;
}
