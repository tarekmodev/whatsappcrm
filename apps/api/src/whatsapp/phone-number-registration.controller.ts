import { Controller, HttpCode, HttpStatus, Param, Post, UseFilters } from '@nestjs/common';
import {
  WhatsAppPhoneNumberParamsSchema,
  type WhatsAppPhoneNumberParams,
  type WhatsAppPhoneNumberRegistrationResponse,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { isTenantNotActiveError, tenantInactive } from '../common/errors/tenant-inactive';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  WhatsAppPhoneNumberRegistrationService,
  type NumberRegistrationState,
} from './phone-number-registration.service';
import { WhatsAppAccountNotFoundError, WhatsAppCredentialMissingError } from './whatsapp.errors';

/**
 * `POST /api/v1/whatsapp/phone-numbers/{whatsappAccountId}/registration` — try
 * registering a connected number for sending again (TAR-170, 0002 amendment
 * 12).
 *
 * ## Why there is a second caller and not a second implementation
 *
 * Registration first runs automatically, as the last step of Embedded Signup.
 * This route exists for what happens when that attempt did not leave the number
 * able to send — a throttle, a Meta outage, a number this platform never got to
 * because the one before it timed out. It drives exactly the method the signup
 * flow drives, so the state written and the reason published are identical
 * whichever attempt produced them. The console reads one field and shows one set
 * of strings.
 *
 * ## The id in the path is ours
 *
 * `{whatsappAccountId}` is the uuid the connect response already published as
 * `accounts[].id`, not Meta's `phone_number_id`. Everything goes through
 * `TenantPrisma`, so another tenant's id is *absent* rather than forbidden and
 * this answers `not_found` — a 403 would confirm the id exists (TAR-39,
 * security).
 *
 * It is not nested under the WABA. A number names exactly one business account
 * and the send path already resolves it that way rather than asking the caller
 * to say which.
 *
 * ## Authentication, permission, and the absence of an idempotency key
 *
 * The ordinary request pipeline and nothing else: host → tenant, cookie →
 * principal, then `channel:manage` — the same permission connecting requires,
 * because this finishes the job connecting started. Tenant-facing, so it never
 * names its own tenant in the path.
 *
 * No request body and no `Idempotency-Key`. Unlike the connect endpoint there is
 * no single-use code to protect, and the operation is idempotent by
 * construction: the same stored PIN, the same Meta call, and a number that
 * already reads `registered` short-circuits before Meta is touched.
 *
 * ## A registration failure answers 200
 *
 * Not `4xx`/`5xx`. The call did what it was asked — it attempted registration
 * and recorded the outcome — and the outcome rides in
 * `registrationFailureReason`. That is forced rather than stylistic: on the
 * first attempt the failure cannot be an error envelope, because the connection
 * succeeded and the response *is* the connection, so an envelope here would make
 * the console parse the same fact two different ways. `rate_limited` and
 * `upstream_unavailable` therefore appear as reasons in a `200` body rather than
 * as the platform error codes of the same name — a deliberate departure from the
 * convention, confined to this field.
 *
 * Genuine errors are still errors, and `translateRegistrationFailure` below is
 * the whole list.
 */
@Controller({ path: 'whatsapp/phone-numbers', version: '1' })
@UseFilters(ApiExceptionFilter)
export class WhatsAppPhoneNumberRegistrationController {
  constructor(private readonly registration: WhatsAppPhoneNumberRegistrationService) {}

  @Post(':whatsappAccountId/registration')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('channel:manage')
  async retry(
    @Param(new ZodValidationPipe(WhatsAppPhoneNumberParamsSchema))
    params: WhatsAppPhoneNumberParams,
  ): Promise<WhatsAppPhoneNumberRegistrationResponse> {
    const state = await this.registration
      .register({ whatsappAccountId: params.whatsappAccountId, attempt: 'retry' })
      .catch((error: unknown) => translateRegistrationFailure(error));

    return toRegistrationResponse(state);
  }
}

/**
 * The one mapping onto the published response, written field by field for the
 * same reason `toConnectedBusinessAccountResponse` is: the PIN column sits on
 * the row this describes, and a spread is how it would eventually escape.
 */
function toRegistrationResponse(
  state: NumberRegistrationState,
): WhatsAppPhoneNumberRegistrationResponse {
  return {
    whatsappAccountId: state.whatsappAccountId,
    phoneNumberId: state.phoneNumberId,
    registrationStatus: state.registrationStatus,
    registrationFailureReason: state.registrationFailureReason,
    registeredAt: state.registeredAt?.toISOString() ?? null,
    registrationAttemptedAt: state.registrationAttemptedAt?.toISOString() ?? null,
  };
}

/**
 * What genuinely is an error here, and nothing else.
 *
 * The four Meta errors are absent on purpose, and their absence is load-bearing:
 * the registration service classifies every one of them into a published reason
 * and records it, so one arriving here would mean an attempt escaped that
 * classification — a fault, and correctly a 500 rather than a 4xx invented at
 * the edge.
 *
 * `WhatsAppCredentialMissingError` is `not_found` to match
 * `translateWhatsAppFailure` on the operator surface: a WABA row with no stored
 * token is not a number anyone can act on. `WhatsAppTokenUndecryptableError` is
 * deliberately not listed — our ciphertext and our configured key disagreeing is
 * a deployment problem, not a mistake in this request, and 0002 amendment 2
 * already rules it a 500.
 */
function translateRegistrationFailure(error: unknown): never {
  if (isTenantNotActiveError(error)) {
    // A deactivated tenant with a session still open. The gate is
    // `assert_tenant_active` inside `TenantPrisma`, so it fires on the first
    // statement rather than at the edge, and the error's own message names the
    // data layer and the tenant id — which is why it never becomes the body
    // (TAR-539).
    throw tenantInactive();
  }

  if (
    error instanceof WhatsAppAccountNotFoundError ||
    error instanceof WhatsAppCredentialMissingError
  ) {
    throw new ApiException('not_found', error.message);
  }

  throw error;
}
