import 'server-only';

import {
  ConnectedWhatsAppBusinessAccountResponseSchema,
  type ConnectedWhatsAppBusinessAccountResponse,
  type WhatsAppEmbeddedSignupInput,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';

/**
 * `POST /api/v1/whatsapp/business-accounts` — the tenant-facing WABA connection
 * TAR-168 shipped. No component calls `fetch`; it calls this, so the response is
 * validated against the contract in exactly one place.
 *
 * There is deliberately no read here, because there is no tenant-facing read to
 * make: the API publishes this route and no `GET`. Until one exists, the console
 * can show what a connection *just* produced and cannot list what was connected
 * before — flagged on TAR-169 rather than papered over with a claim the console
 * cannot support.
 *
 * Nothing about this call is retryable and nothing may defer it: Meta's code is
 * single-use and lives about 30 seconds, which is why the route takes no
 * `Idempotency-Key` and why the caller above is a click handler rather than a
 * queue.
 */
const WHATSAPP_BUSINESS_ACCOUNTS_PATH = '/v1/whatsapp/business-accounts';

export async function connectWhatsAppBusinessAccount(
  input: WhatsAppEmbeddedSignupInput,
): Promise<ConnectedWhatsAppBusinessAccountResponse> {
  const response = await authenticatedRequest({
    method: 'POST',
    path: WHATSAPP_BUSINESS_ACCOUNTS_PATH,
    body: input,
  });

  return ConnectedWhatsAppBusinessAccountResponseSchema.parse(response);
}
