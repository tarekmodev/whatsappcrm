import 'server-only';

import { cache } from 'react';
import type { CannedResponseResponse } from '@whatsappcrm/contracts';
import { ApiRequestError } from '@/lib/api/http';
import { listCannedResponses } from '@/lib/api/canned-responses';

/**
 * The tenant's canned-response library, read once per render and handed to the
 * composer as a prop (ADR 0011, decision 1).
 *
 * ## Why this one degrades instead of throwing
 *
 * Every other loader in this feature lets a failure reach the section's error
 * boundary, because without it there is no thread to show. This one is different:
 * the picker is an accelerator over a composer that works perfectly well without
 * it. 0011 is explicit — "the composer renders with no picker; sends still work",
 * and "nothing here can refuse a send or raise an error". A canned-response
 * endpoint that is down must not take the reply box down with it.
 *
 * So an `ApiRequestError` — a 5xx, and the `forbidden` a role without
 * `canned_response:read` would get — becomes an empty set, logged. Everything
 * else is rethrown: a malformed row is a contract drift the boundary should
 * report, and the `redirect` a lost session throws is not this loader's to
 * swallow.
 *
 * Request-cached so the thread pane and anything else on the route that wants
 * the set are one read, matching `loadConversationThread` beside it.
 */
export const loadCannedResponses = cache(async function loadCannedResponses(): Promise<
  readonly CannedResponseResponse[]
> {
  try {
    return await listCannedResponses();
  } catch (error) {
    if (error instanceof ApiRequestError) {
      // Not swallowed: an operator needs to see that the library is unreachable,
      // because on screen it is indistinguishable from a tenant that has none.
      console.error('Canned responses could not be loaded; the composer will show no picker.', {
        status: error.status,
        code: error.code,
        requestId: error.requestId,
      });

      return [];
    }

    throw error;
  }
});
