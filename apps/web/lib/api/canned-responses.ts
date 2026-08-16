import 'server-only';

import {
  CannedResponseListResponseSchema,
  type CannedResponseResponse,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';

/**
 * `/api/v1/canned-responses`, per ADR 0011's REST surface.
 *
 * Only the list. 0011 decision 1 resolves a typed shortcut in the console
 * against its copy of the whole set and rejects a per-token lookup route on
 * purpose, so the composer needs one read and no request on the keystroke path.
 * The writes belong to a settings screen that does not exist yet; adding client
 * functions for endpoints nothing calls would be dead code.
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
