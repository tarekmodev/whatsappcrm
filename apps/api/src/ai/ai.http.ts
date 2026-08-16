import { ApiException } from '../common/errors/api.exception';
import { ConversationNotFoundError } from '../conversations/conversations.errors';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import {
  AiFeatureNotInPlanError,
  HandoffNotFoundError,
  InvalidKnowledgeCursorError,
  KnowledgeDocumentCapReachedError,
  KnowledgeDocumentNotFoundError,
} from './ai.errors';

/**
 * The one place an AI-surface failure becomes an HTTP answer, on
 * `translateSlaFailure`'s pattern.
 *
 * Written once rather than per route so the same condition cannot answer 404 on
 * one and 403 on another. **No new error code**: 0010 checked the published
 * taxonomy against every refusal this surface has and found it complete, so
 * nothing here invents one — `error-codes.ts` is something 0002 rules, not
 * something an implementation edits.
 *
 * Two mappings carry a security consequence:
 *
 *   * **An unknown document id, and another tenant's, are the same
 *     `not_found`.** A 403 on the second would confirm the id names a real row
 *     somewhere.
 *   * **A conversation with no handoff and one the principal may not see are
 *     also the same `not_found`** — the rule the rest of the inbox already
 *     applies, kept here so the handoff endpoint cannot become the one that
 *     leaks which conversation ids exist.
 *
 * Anything unrecognised is rethrown untouched: it is a fault, and reporting a
 * database outage as a validation error would hide it.
 */
export function translateAiFailure(error: unknown): never {
  if (
    error instanceof KnowledgeDocumentNotFoundError ||
    error instanceof HandoffNotFoundError ||
    error instanceof ConversationNotFoundError
  ) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof KnowledgeDocumentCapReachedError) {
    throw new ApiException('conflict', error.message);
  }

  if (error instanceof AiFeatureNotInPlanError) {
    throw new ApiException('feature_not_in_plan', error.message);
  }

  if (error instanceof InvalidKnowledgeCursorError) {
    throw new ApiException('validation_failed', error.message, [
      { path: error.parameter, message: error.message },
    ]);
  }

  if (error instanceof TenantNotActiveError) {
    // A deactivated tenant with a session still open (TAR-51). A runtime state
    // an operator created, not a fault — reporting it as 500 would page someone
    // every time a tenant was shut off.
    throw new ApiException('forbidden', error.message);
  }

  throw error;
}
