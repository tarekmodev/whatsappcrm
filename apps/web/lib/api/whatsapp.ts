import 'server-only';

import {
  ConnectedWhatsAppBusinessAccountResponseSchema,
  WhatsAppPhoneNumberRegistrationResponseSchema,
  type ConnectedWhatsAppBusinessAccountResponse,
  type WhatsAppEmbeddedSignupInput,
  type WhatsAppPhoneNumberRegistrationResponse,
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
 * cannot support. TAR-814's connect wizard is what pays for that: it resumes
 * from a client-side cache of this response (`features/whatsapp/wizard-storage.ts`)
 * because there is no read to resume from.
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

/**
 * `POST /api/v1/whatsapp/phone-numbers/{whatsappAccountId}/registration` — try
 * registering a connected number for sending again (TAR-170).
 *
 * The id is **ours** — `accounts[].id` from the connect response above, not
 * Meta's `phone_number_id`. Interpolated without encoding because the caller
 * validates it against the contract's `WhatsAppPhoneNumberParamsSchema` first,
 * which admits UUIDs and nothing else.
 *
 * No body, and no `Idempotency-Key`: there is no spent code to protect here, and
 * the operation is idempotent by construction — a number that already reads
 * `registered` short-circuits before Meta is touched, which is what makes this
 * safe to call again to confirm a state rather than to change one.
 *
 * **A refused registration is a `200`.** The call did what it was asked and the
 * outcome rides in `registrationFailureReason` (0002, amendment 12), so a caller
 * that only branches on a thrown error would read every refusal as a success.
 */
export async function registerWhatsAppPhoneNumber(
  whatsappAccountId: string,
): Promise<WhatsAppPhoneNumberRegistrationResponse> {
  const response = await authenticatedRequest({
    method: 'POST',
    path: `/v1/whatsapp/phone-numbers/${whatsappAccountId}/registration`,
  });

  return WhatsAppPhoneNumberRegistrationResponseSchema.parse(response);
}
