import { KNOWLEDGE_DOCUMENT_LIMITS } from '@whatsappcrm/contracts';

/**
 * The failures the AI surface produces, as typed domain errors rather than
 * `HttpException`s.
 *
 * The same split `sla.errors.ts` and `conversations.errors.ts` make, for the
 * same reason: a service has no business choosing a status code, and
 * `ai.http.ts` is the one place that decides. Anything not listed here reaches
 * the caller as a 500, which is the correct answer for a fault.
 *
 * **Provider failures are deliberately absent.** They happen in a worker, never
 * on an HTTP path, and they become `handoff:bot_error` — a customer reaches a
 * human rather than a status code. `upstream_unavailable` exists in the
 * published taxonomy and is deliberately unused by this module.
 */

export abstract class AiError extends Error {
  protected constructor(message: string) {
    super(message);
    // `Error` breaks the prototype chain when a class extending it is
    // down-levelled, which would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * No knowledge-base document matches that id — it does not exist, or it belongs
 * to another tenant. Both are the same error and both answer 404: RLS has
 * already made them indistinguishable, and a 403 on the second would confirm the
 * id names a real row somewhere.
 */
export class KnowledgeDocumentNotFoundError extends AiError {
  constructor(readonly documentId: string) {
    super('No knowledge base document matches that id.');
  }
}

/** A cursor this build cannot act on. The controller turns it into `validation_failed`. */
export class InvalidKnowledgeCursorError extends AiError {
  constructor(readonly parameter: string) {
    super('The cursor is not valid. Start from the first page.');
  }
}

/**
 * The tenant already holds `KNOWLEDGE_DOCUMENT_LIMITS.documentsPerTenant`
 * documents.
 *
 * `conflict` rather than `plan_limit_exceeded`: the cap is a platform bound on
 * how large a knowledge base may get, not something a plan sells more of, and
 * reporting it as a billing refusal would send an admin to a pricing page that
 * cannot help them.
 */
export class KnowledgeDocumentCapReachedError extends AiError {
  constructor() {
    super(
      `A tenant may hold at most ${KNOWLEDGE_DOCUMENT_LIMITS.documentsPerTenant} knowledge base documents. ` +
        'Delete one before adding another.',
    );
  }
}

/**
 * The tenant's plan does not include `ai_chatbot`, on a route that writes.
 *
 * `GET /ai/config` is deliberately exempt and never raises this: the console has
 * to render an upsell rather than a 403 page, so the read answers with
 * `readiness.blockers` naming the same fact.
 */
export class AiFeatureNotInPlanError extends AiError {
  constructor() {
    super('The AI chatbot is not included in this plan.');
  }
}

/**
 * The conversation has no handoff to report — it never handed off, or the
 * principal may not see it.
 *
 * One error for both, because the alternative leaks: answering 404 for the first
 * and 403 for the second tells a caller which conversation ids are real. The
 * same `not_found`-never-`forbidden` rule the rest of the inbox uses.
 */
export class HandoffNotFoundError extends AiError {
  constructor(readonly conversationId: string) {
    super('That conversation has no handoff.');
  }
}
