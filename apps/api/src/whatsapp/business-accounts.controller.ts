import { Body, Controller, HttpCode, HttpStatus, Post, Res, UseFilters } from '@nestjs/common';
import {
  WhatsAppEmbeddedSignupInputSchema,
  whatsAppSignupFailureDetails,
  type ConnectedWhatsAppBusinessAccountResponse,
  type WhatsAppEmbeddedSignupInput,
} from '@whatsappcrm/contracts';
import type { Response } from 'express';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { isTenantNotActiveError, tenantInactive } from '../common/errors/tenant-inactive';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { toConnectedBusinessAccountResponse } from './connected-business-account.response';
import { WhatsAppEmbeddedSignupService } from './embedded-signup.service';
import { MetaRateLimitedError, MetaUnavailableError } from './meta-cloud-api.errors';
import { WhatsAppIdentityTakenError, WhatsAppSignupFailedError } from './whatsapp.errors';

/**
 * `POST /api/v1/whatsapp/business-accounts` — a tenant connects its own WhatsApp
 * Business Account, having just completed Meta's Embedded Signup in the console
 * (TAR-168, 0002 amendment 2).
 *
 * ## Authentication and permission
 *
 * Ordinary request pipeline, and deliberately nothing else: `HostTenantGuard`
 * resolves the tenant from the host, `PrincipalGuard` resolves the session, and
 * `PermissionGuard` refuses anyone without `channel:manage` before this handler
 * exists. No `@PlatformRoute()`, no second authentication scheme — the operator
 * route keeps its bearer token, and this one gets the same tenant-isolation
 * guarantee every other tenant-scoped route gets, from the same mechanism.
 *
 * Tenant-facing, so it never names its own tenant in the path (0002, decision
 * 2): the tenant is the caller's, resolved before the handler, and a caller
 * cannot reach a neighbour's WABA because there is no place in this contract to
 * ask for one.
 *
 * ## Status codes, and the absence of an idempotency key
 *
 * `201` when this call connected the account and `200` when it was already
 * connected and this updated it — the same signal the operator route gives,
 * because the underlying operation is the same one and is idempotent on
 * `wabaId`.
 *
 * It takes no `Idempotency-Key` and is not retryable: Meta's code is single-use
 * and lives about 30 seconds, so replaying the request replays a spent code. The
 * retry unit is the *flow*, which the console re-runs for a fresh code — which
 * is what `details.reason` on the failures below is for.
 */
@Controller({ path: 'whatsapp/business-accounts', version: '1' })
@UseFilters(ApiExceptionFilter)
export class WhatsAppBusinessAccountsController {
  constructor(private readonly signup: WhatsAppEmbeddedSignupService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('channel:manage')
  async connect(
    @Body(new ZodValidationPipe(WhatsAppEmbeddedSignupInputSchema))
    input: WhatsAppEmbeddedSignupInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConnectedWhatsAppBusinessAccountResponse> {
    // `phoneNumberId` is published as a hint and is deliberately not passed on:
    // the numbers that get attached are the ones Meta lists against the token it
    // just issued, so there is one authority for what was connected.
    const result = await this.signup
      .connect({ code: input.code, wabaId: input.wabaId })
      .catch((error: unknown) => translateSignupFailure(error));

    if (!result.created) {
      response.status(HttpStatus.OK);
    }

    return toConnectedBusinessAccountResponse(result);
  }
}

/**
 * Maps the signup failures onto the published taxonomy (0002, amendment 2's
 * table). Anything not listed reaches Nest's default handler as a 500, which is
 * the correct answer for a fault.
 *
 * `MetaAuthenticationError` and `MetaRequestRejectedError` are absent on
 * purpose, and their absence is load-bearing: every Meta call in this flow is
 * classified by `WhatsAppEmbeddedSignupService` into a reason the console can
 * act on, so one arriving here unclassified means a call was added without
 * deciding what its failure tells the tenant — a fault, not a 4xx.
 *
 * `whatsapp_send_failed` is not reused. Nothing was sent, and an operator
 * reading it in a log would go looking for a message.
 */
function translateSignupFailure(error: unknown): never {
  if (error instanceof WhatsAppSignupFailedError) {
    throw new ApiException(
      'whatsapp_signup_failed',
      error.message,
      error.reason === null ? undefined : whatsAppSignupFailureDetails(error.reason),
    );
  }

  if (error instanceof WhatsAppIdentityTakenError) {
    // That WABA or number belongs to another tenant. The message names the id
    // the caller supplied and nothing about who holds it.
    throw new ApiException('conflict', error.message);
  }

  if (error instanceof MetaRateLimitedError) {
    throw new ApiException('rate_limited', error.message);
  }

  if (error instanceof MetaUnavailableError) {
    throw new ApiException('upstream_unavailable', error.message);
  }

  if (isTenantNotActiveError(error)) {
    // A deactivated tenant with a session still open. The gate is
    // `assert_tenant_active` inside `TenantPrisma`, so it fires on the first
    // statement of the connection rather than at the edge. The error's own
    // message names the data layer and the tenant id, so it never becomes the
    // body (TAR-539).
    throw tenantInactive();
  }

  throw error;
}
