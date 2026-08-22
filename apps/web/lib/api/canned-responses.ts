import 'server-only';

import {
  CannedResponseListResponseSchema,
  CannedResponseResponseSchema,
  type CannedResponseCreateInput,
  type CannedResponseResponse,
  type CannedResponseUpdateInput,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';

/**
 * `/api/v1/canned-responses`, per ADR 0011's REST surface.
 *
 * The read is what the composer needs: 0011 decision 1 resolves a typed shortcut
 * in the console against its copy of the whole set and rejects a per-token lookup
 * route on purpose, so one request and nothing on the keystroke path.
 *
 * The three writes are the admin surface's (TAR-575). They landed later than the
 * read because until `/settings/saved-replies` existed nothing called them, and
 * the only way to add a reply was a `curl` a tenant admin cannot be asked to run.
 *
 * The list is unpaginated and capped server-side at
 * `CANNED_RESPONSE_LIMITS.perTenant`, which is what makes "the whole set" a
 * promise the API can keep — the same shape `assignment-rules` uses, and the
 * reason `nextCursor` is thrown away here rather than handed to a caller who
 * could never use it.
 *
 * Tenant scoping is the API's, from the session cookie. There is no tenant
 * parameter here to get wrong.
 */

const CANNED_RESPONSES_PATH = '/v1/canned-responses';

export async function listCannedResponses(): Promise<readonly CannedResponseResponse[]> {
  const response = await authenticatedRequest({ method: 'GET', path: CANNED_RESPONSES_PATH });

  return CannedResponseListResponseSchema.parse(response).items;
}

/**
 * `conflict` on a shortcut this tenant already holds — case-insensitively, since
 * `shortcut` is `citext` — and on the per-tenant cap. Both are refusals the admin
 * can act on, so `runAction` shows the API's own message rather than the generic
 * line.
 */
export async function createCannedResponse(
  input: CannedResponseCreateInput,
): Promise<CannedResponseResponse> {
  const response = await authenticatedRequest({
    method: 'POST',
    path: CANNED_RESPONSES_PATH,
    body: input,
  });

  return CannedResponseResponseSchema.parse(response);
}

/**
 * Every field is editable, unlike a custom field's key: a shortcut is what an
 * agent types, not what a stored value is filed under, so renaming one breaks
 * nothing that outlives the keystroke. `CannedResponseUpdateInputSchema` is the
 * create input partial, so a caller sends only what changed.
 */
export async function updateCannedResponse(
  id: string,
  input: CannedResponseUpdateInput,
): Promise<CannedResponseResponse> {
  const response = await authenticatedRequest({
    method: 'PATCH',
    path: `${CANNED_RESPONSES_PATH}/${encodeURIComponent(id)}`,
    body: input,
  });

  return CannedResponseResponseSchema.parse(response);
}

/** `204`, and idempotent — deleting an already-deleted response is not a 404. */
export async function deleteCannedResponse(id: string): Promise<void> {
  await authenticatedRequest({
    method: 'DELETE',
    path: `${CANNED_RESPONSES_PATH}/${encodeURIComponent(id)}`,
  });
}
