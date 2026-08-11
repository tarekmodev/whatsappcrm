import 'server-only';

import {
  IdSchema,
  MessageResponseSchema,
  type MessageResponse,
  type SendMessageInput,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';

/**
 * Sending, which `conversations.ts` deliberately left out: it is the one call in
 * the resource layer that carries an `Idempotency-Key`, and the header is what
 * this module exists to make impossible to forget.
 */

const CONVERSATIONS_PATH = '/v1/conversations';

/** Lower-cased, matching the API's own constant; HTTP header names are case-insensitive. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * `POST /api/v1/conversations/{id}/messages`.
 *
 * The API requires `Idempotency-Key` and requires it to be a UUID: a send is the
 * one action in this product that cannot be undone, so a double-submitted form,
 * a retried fetch or a reloaded tab must not reach the customer twice. Replaying
 * the *same* key with the *same* body returns the original 201 rather than
 * sending again; replaying it with a different body is refused as
 * `idempotency_key_reused`, which is why the composer mints a fresh key whenever
 * the draft changes.
 *
 * The answer is a `MessageResponse` with `status: 'queued'` — the row is
 * committed and the Cloud API call is queued behind it. Everything after that
 * (`sent`, `delivered`, `read`, `failed`) arrives over the realtime gateway.
 */
export async function sendMessage(
  conversationId: string,
  input: SendMessageInput,
  idempotencyKey: string,
): Promise<MessageResponse> {
  // A malformed key is a bug in the caller, not something an agent can act on:
  // it fails here, before a send, rather than as a `validation_failed` naming a
  // header the person at the keyboard never typed.
  if (!IdSchema.safeParse(idempotencyKey).success) {
    throw new Error('An Idempotency-Key must be a UUID; the composer must mint one per draft.');
  }

  const response = await authenticatedRequest({
    method: 'POST',
    path: `${CONVERSATIONS_PATH}/${conversationId}/messages`,
    body: input,
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
  });

  return MessageResponseSchema.parse(response);
}
