import { ApiException } from '../common/errors/api.exception';
import {
  IdempotencyKeyReusedError,
  IdempotentRequestInFlightError,
} from '../common/idempotency/idempotency.errors';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { UnknownWhatsAppAccountError } from '../whatsapp/message-template-query.service';
import {
  ContactOptedOutError,
  ConversationAlreadyClaimedError,
  ConversationNotFoundError,
  ConversationUnclaimedError,
  InvalidConversationCursorError,
  SendMediaNotUsableError,
  ServiceWindowExpiredError,
  TemplateNotSendableError,
  UnknownTenantMemberError,
} from './conversations.errors';

/**
 * The one place an inbox failure becomes an HTTP answer.
 *
 * Written once rather than per route so the same condition cannot answer 404 on
 * one and 403 on another — the property `httpStatusForErrorCode` gives inside a
 * code, applied to the layer that chooses the code.
 *
 * Three of the mappings are where information leaks if they are got wrong:
 *
 *   * **A conversation the caller may not see is `not_found`, never
 *     `forbidden`.** Another tenant's thread is already invisible, and a 403 on
 *     one belonging to a colleague would confirm the id names a real
 *     conversation somebody is handling.
 *   * **The window and the template have codes of their own.** The composer
 *     branches on `whatsapp_window_expired` to switch to the template picker and
 *     on `whatsapp_template_invalid` to correct the inputs; folding either into
 *     `validation_failed` would make both indistinguishable from a typo.
 *   * **A replayed key is `idempotency_key_reused`, not `conflict`.** They are
 *     different facts: a conflict is retryable with the same key and this one
 *     never is.
 *
 * Anything unrecognised is rethrown untouched: it is a fault, and reporting a
 * database outage as a validation error would hide it.
 */
export function translateConversationFailure(error: unknown): never {
  if (error instanceof ConversationNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof ServiceWindowExpiredError) {
    throw new ApiException('whatsapp_window_expired', error.message);
  }

  if (
    error instanceof ConversationUnclaimedError ||
    error instanceof ConversationAlreadyClaimedError
  ) {
    // Both are the state of the row refusing a request the caller is otherwise
    // entitled to make, which is what `conflict` means — never `forbidden`,
    // which would say the role is wrong when claiming would fix it. They share
    // a code and differ in message for the same reason `contact_opted_out` has
    // none: inventing codes here would make `error-codes.ts` something an
    // implementation edits. Publishing a code the composer can branch on to
    // offer "Claim" in place of "Retry" is the recorded 0002 follow-up.
    throw new ApiException('conflict', error.message);
  }

  if (error instanceof TemplateNotSendableError) {
    throw new ApiException('whatsapp_template_invalid', error.message, [
      { path: 'templateName', message: error.message },
    ]);
  }

  if (error instanceof ContactOptedOutError) {
    // No `contact_opted_out` in the published taxonomy, and a code invented
    // here would make `error-codes.ts` something an implementation edits rather
    // than something 0002 rules. `conflict` is the honest existing answer — the
    // request conflicts with the resource's state — and a dedicated code is a
    // contract follow-up.
    throw new ApiException('conflict', error.message);
  }

  if (error instanceof SendMediaNotUsableError) {
    throw new ApiException('validation_failed', error.message, [
      { path: 'mediaId', message: error.message },
    ]);
  }

  if (error instanceof UnknownTenantMemberError) {
    throw new ApiException('validation_failed', error.message, [
      { path: error.field, message: error.message },
    ]);
  }

  if (error instanceof InvalidConversationCursorError) {
    throw new ApiException('validation_failed', error.message, [
      { path: error.parameter, message: error.message },
    ]);
  }

  if (error instanceof IdempotencyKeyReusedError) {
    throw new ApiException('idempotency_key_reused', error.message);
  }

  if (error instanceof IdempotentRequestInFlightError) {
    throw new ApiException('conflict', error.message);
  }

  if (error instanceof UnknownWhatsAppAccountError) {
    // The conversation names a number that no longer resolves — a WABA
    // disconnected under a live thread. Not the caller's input, and not a
    // server fault either: there is nothing to send from until the channel is
    // reconnected.
    throw new ApiException(
      'conflict',
      'The WhatsApp number this conversation belongs to is no longer connected.',
    );
  }

  if (error instanceof TenantNotActiveError) {
    // A deactivated tenant with a session still open (TAR-51). A runtime state
    // an operator created, not a fault — reporting it as 500 would page someone
    // every time a tenant was shut off. TAR-41's global filter takes this over.
    throw new ApiException('forbidden', error.message);
  }

  throw error;
}
