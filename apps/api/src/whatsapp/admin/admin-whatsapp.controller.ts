import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ConnectWhatsAppBusinessAccountInputSchema,
  WhatsAppAdminBusinessAccountParamsSchema,
  WhatsAppAdminTenantParamsSchema,
  type ConnectWhatsAppBusinessAccountInput,
  type ConnectedWhatsAppBusinessAccountResponse,
  type SyncMessageTemplatesResponse,
  type WhatsAppAdminBusinessAccountParams,
  type WhatsAppAdminTenantParams,
} from '@whatsappcrm/contracts';
import type { Response } from 'express';
import { ApiExceptionFilter } from '../../common/errors/api-exception.filter';
import { ApiException } from '../../common/errors/api.exception';
import { PlatformRoute } from '../../common/request-pipeline/route-access';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { TenantNotActiveError } from '../../prisma/prisma.errors';
import { AdminTenantScopeService } from '../../tenancy/admin/admin-tenant-scope.service';
import { PlatformAdminGuard } from '../../tenancy/admin/platform-admin.guard';
import { TenantNotFoundError } from '../../tenancy/tenant-deactivation.errors';
import {
  WhatsAppBusinessAccountConnectionService,
  type ConnectBusinessAccountResult,
} from '../business-account-connection.service';
import {
  MessageTemplateSyncService,
  type SyncMessageTemplatesResult,
} from '../message-template-sync.service';
import {
  MetaAuthenticationError,
  MetaRateLimitedError,
  MetaRequestRejectedError,
  MetaUnavailableError,
} from '../meta-cloud-api.errors';
import {
  WhatsAppBusinessAccountNotFoundError,
  WhatsAppCredentialMissingError,
  WhatsAppIdentityTakenError,
} from '../whatsapp.errors';

/**
 * The platform-admin WhatsApp surface: connecting a customer's WhatsApp Business
 * Account to their tenant, and reconciling that account's templates with Meta.
 *
 * ## Why these are admin routes and not tenant routes
 *
 * TAR-39's eventual answer is Meta's Embedded Signup, where a tenant admin with
 * `channel:manage` completes the flow in their own browser and the platform
 * never handles a token by hand. That needs TAR-35's sessions and TAR-22's
 * permissions, neither of which exists.
 *
 * Rather than ship an unauthenticated tenant route, or wait, the connection is
 * an operator action here: `PlatformAdminGuard` is real authentication that
 * works today, and the most sensitive credential in the system stays behind the
 * people who run the platform until there is a customer-facing flow worth
 * trusting with it. When Embedded Signup lands, it adds a tenant-facing route
 * that calls the same service — every isolation and encryption property below is
 * independent of how the caller was authenticated.
 *
 * The guard is declared on the controller rather than per route, so a route
 * added later is protected by default instead of by remembering.
 *
 * ## How a tenant gets into scope
 *
 * The path names the tenant by slug. `AdminTenantScopeService.enter()` resolves
 * it and binds it to this request's `AsyncLocalStorage` scope, so everything
 * downstream runs through `TenantPrisma` with RLS enforcing the boundary — the
 * same guarantee a session-authenticated request gets, from a different source
 * of truth for who the tenant is.
 *
 * That is also why `@PlatformRoute()` is safe here (TAR-58): it skips the global
 * `HostTenantGuard`, so nothing is in scope until `enter()` puts it there, and a
 * route that forgot to call it would fail closed on `TenantPrisma` rather than
 * read whichever tenant the host happened to resolve.
 */
@Controller({ path: 'admin/tenants/:slug/whatsapp', version: '1' })
@PlatformRoute()
@UseGuards(PlatformAdminGuard)
@UseFilters(ApiExceptionFilter)
export class AdminWhatsAppController {
  constructor(
    private readonly tenantScope: AdminTenantScopeService,
    private readonly connection: WhatsAppBusinessAccountConnectionService,
    private readonly templateSync: MessageTemplateSyncService,
  ) {}

  /**
   * `POST /api/v1/admin/tenants/{slug}/whatsapp/business-accounts` — connect a
   * WABA and its phone numbers.
   *
   * Idempotent on `wabaId`, and the status code is how the caller tells the two
   * cases apart: `201` when this call connected the account, `200` when it was
   * already connected and this updated it. The body is the same either way —
   * this follows `POST /api/v1/admin/tenants` deliberately, because an operator
   * re-running a setup script needs to know which of the two happened.
   *
   * Re-sending with a new `accessToken` is how a token is rotated.
   */
  @Post('business-accounts')
  @HttpCode(HttpStatus.CREATED)
  async connect(
    @Param(new ZodValidationPipe(WhatsAppAdminTenantParamsSchema))
    params: WhatsAppAdminTenantParams,
    @Body(new ZodValidationPipe(ConnectWhatsAppBusinessAccountInputSchema))
    input: ConnectWhatsAppBusinessAccountInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConnectedWhatsAppBusinessAccountResponse> {
    await this.enterTenant(params.slug);

    const result = await this.connection
      .connect({
        wabaId: input.wabaId,
        name: input.name,
        accessToken: input.accessToken,
        verificationStatus: input.verificationStatus,
        phoneNumbers: input.phoneNumbers,
      })
      .catch((error: unknown) => translateWhatsAppFailure(error));

    if (!result.created) {
      response.status(HttpStatus.OK);
    }

    return toConnectedResponse(result);
  }

  /**
   * `POST /api/v1/admin/tenants/{slug}/whatsapp/business-accounts/{wabaId}/template-sync`
   * — pull this WABA's templates from Meta and reconcile them.
   *
   * A sub-resource POST rather than a `PATCH` on a template collection: this is
   * an operation with an external side effect, not an edit, and TAR-39's
   * conventions put a non-CRUD verb on a sub-resource.
   *
   * Separate from the connection call on purpose. Folding the sync into `connect`
   * would mean a Meta outage turning a successful, correctly-stored connection
   * into an error the operator has to interpret — and then re-running the whole
   * thing, token and all, to retry a read.
   *
   * Always `200`: a sync creates no resource of its own, and the counts in the
   * body are the outcome.
   */
  @Post('business-accounts/:wabaId/template-sync')
  @HttpCode(HttpStatus.OK)
  async syncTemplates(
    @Param(new ZodValidationPipe(WhatsAppAdminBusinessAccountParamsSchema))
    params: WhatsAppAdminBusinessAccountParams,
  ): Promise<SyncMessageTemplatesResponse> {
    await this.enterTenant(params.slug);

    // The path names Meta's id; the resolution behind `syncByWabaId` goes
    // through `TenantPrisma`, so a WABA connected to another tenant comes back
    // as absent rather than forbidden (TAR-39, security).
    const result = await this.templateSync
      .syncByWabaId(params.wabaId)
      .catch((error: unknown) => translateWhatsAppFailure(error));

    return toSyncResponse(result);
  }

  private async enterTenant(slug: string): Promise<void> {
    await this.tenantScope.enter(slug).catch((error: unknown) => {
      if (error instanceof TenantNotFoundError) {
        throw new ApiException('not_found', error.message);
      }

      throw error;
    });
  }
}

/**
 * Maps this module's domain errors onto the published taxonomy. Anything not
 * listed reaches Nest's default handler as a 500, which is the correct answer
 * for a fault.
 *
 * Two are deliberately left in that group. `WhatsAppEncryptionUnavailableError`
 * means this environment was never given an encryption key, and
 * `WhatsAppTokenUndecryptableError` means our stored ciphertext and our
 * configured key disagree. Both are our misconfiguration, not a mistake the
 * operator made in this request, and reporting either as a 4xx would send
 * someone hunting through a request body for a problem that is in the
 * deployment.
 */
function translateWhatsAppFailure(error: unknown): never {
  if (error instanceof TenantNotActiveError) {
    // Reachable here in a way it is not on a session-authenticated route: an
    // operator can name a tenant that has since been deactivated. The gate is
    // `assert_tenant_active` inside `TenantPrisma`, so it fires on the first
    // statement rather than at the edge. TAR-41's global filter will own this
    // mapping for every route; until then the routes that can hit it map it
    // themselves rather than answering 500 for a state an operator created.
    throw new ApiException('forbidden', error.message);
  }

  if (error instanceof WhatsAppIdentityTakenError) {
    throw new ApiException('conflict', error.message);
  }

  if (
    error instanceof WhatsAppBusinessAccountNotFoundError ||
    error instanceof WhatsAppCredentialMissingError
  ) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof MetaAuthenticationError || error instanceof MetaRequestRejectedError) {
    // Not `unauthenticated`: the *operator* authenticated fine. What failed is
    // the tenant's stored Meta credential or the request Meta was given, which
    // is a channel failure.
    throw new ApiException('whatsapp_send_failed', error.message);
  }

  if (error instanceof MetaRateLimitedError) {
    throw new ApiException('rate_limited', error.message);
  }

  if (error instanceof MetaUnavailableError) {
    throw new ApiException('upstream_unavailable', error.message);
  }

  throw error;
}

/**
 * Explicit rather than spread, so widening a projection cannot quietly add a
 * field to the API. This is the mapping the encrypted access token would have to
 * pass through to escape, and it does not appear here.
 */
function toConnectedResponse({
  businessAccount,
}: ConnectBusinessAccountResult): ConnectedWhatsAppBusinessAccountResponse {
  return {
    id: businessAccount.id,
    wabaId: businessAccount.wabaId,
    name: businessAccount.name,
    verificationStatus: businessAccount.verificationStatus,
    createdAt: businessAccount.createdAt.toISOString(),
    updatedAt: businessAccount.updatedAt.toISOString(),
    accounts: businessAccount.accounts.map((account) => ({
      id: account.id,
      whatsappBusinessAccountId: account.whatsappBusinessAccountId,
      phoneNumberId: account.phoneNumberId,
      displayPhoneNumber: account.displayPhoneNumber,
      verifiedName: account.verifiedName,
      qualityRating: account.qualityRating,
      status: account.status,
      createdAt: account.createdAt.toISOString(),
      updatedAt: account.updatedAt.toISOString(),
    })),
  };
}

function toSyncResponse(result: SyncMessageTemplatesResult): SyncMessageTemplatesResponse {
  return {
    whatsappBusinessAccountId: result.whatsappBusinessAccountId,
    wabaId: result.wabaId,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    total: result.total,
    syncedAt: result.syncedAt.toISOString(),
  };
}
