import 'server-only';

import type { CannedResponseResponse } from '@whatsappcrm/contracts';
import { listCannedResponses } from '@/lib/api/canned-responses';

/**
 * The server-side read for the saved-reply admin surface.
 *
 * Deliberately **not** `features/inbox/canned-responses.data.ts`, which is the
 * composer's read and swallows an `ApiRequestError` into an empty set on
 * purpose: 0011 requires the reply box to work with no picker rather than break,
 * so a library that is down costs an agent an accelerator. On this screen the
 * library *is* the content, and an empty table where the read failed would tell
 * an admin their workspace has no saved replies and invite them to re-create
 * every one. So this one lets the failure reach the section's error boundary.
 *
 * The list is the whole set and does not paginate: `CANNED_RESPONSE_LIMITS.perTenant`
 * is enforced on create, which is what makes a bounded response a promise the
 * server can keep (0011, decision 1).
 */
export async function loadCannedResponses(): Promise<readonly CannedResponseResponse[]> {
  return listCannedResponses();
}
