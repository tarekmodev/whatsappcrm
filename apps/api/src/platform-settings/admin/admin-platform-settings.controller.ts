import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  PlatformSettingParamsSchema,
  SetPlatformSettingInputSchema,
  type PlatformSettingHistoryResponse,
  type PlatformSettingListResponse,
  type PlatformSettingParams,
  type PlatformSettingView,
  type SetPlatformSettingInput,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../../common/errors/api-exception.filter';
import { ApiException } from '../../common/errors/api.exception';
import { PlatformRoute } from '../../common/request-pipeline/route-access';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PlatformAdminGuard } from '../../tenancy/admin/platform-admin.guard';
import {
  PlatformSettingValueInvalidError,
  PlatformSettingsEncryptionUnavailableError,
  UnknownPlatformSettingError,
} from '../platform-settings.errors';
import { PlatformSettingsService } from '../platform-settings.service';

/**
 * The platform-operator surface for configuration that used to require a
 * redeploy to change (TAR-816).
 *
 * `@PlatformRoute()` takes it out of the tenant pipeline — the operator is not a
 * user in any tenant, and these values belong to no tenant — and
 * `PlatformAdminGuard` is the authentication that replaces it. The guard is on
 * the class rather than per route, so a route added later is protected by
 * default rather than by remembering.
 *
 * ## What is deliberately absent
 *
 * **There is no reveal route.** No endpoint on this controller returns the
 * plaintext of a key the registry classifies `secret`, to anyone, and no role
 * unlocks one — there is no role model here to unlock it with. That dissolves
 * "who may read a value in the clear" rather than answering it: everyone with
 * admin access reads masked, nobody reads plaintext. What an operator actually
 * needs — is it set, when did it change, who changed it, does staging hold the
 * same value — is `isSet`, `updatedAt`, `updatedByLabel`, `fingerprint` and
 * `hint`, all of which this surface does return.
 *
 * ## The known limitation
 *
 * Authorisation is all-or-nothing: any credential that can list tenants can
 * rewrite the Meta app secret, because `PlatformAdminGuard` has one shared
 * bearer-token set with no per-route scopes. Inventing a scope model inside this
 * feature would be a second authorisation system in the codebase, so it is
 * stated rather than designed around (TAR-811, risk 2). Every write is
 * attributed to a credential label through the existing `setPlatformActor`
 * mechanism, so revoking one operator remains "delete one entry".
 */
@Controller({ path: 'admin/platform-settings', version: '1' })
@PlatformRoute()
@UseGuards(PlatformAdminGuard)
@UseFilters(ApiExceptionFilter)
export class AdminPlatformSettingsController {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `GET /api/v1/admin/platform-settings` — every managed key, set or not.
   *
   * Unpaginated, and that is not an oversight: the list is the code-owned
   * registry rather than a table, so it is bounded at review time and cannot
   * grow from traffic.
   */
  @Get()
  list(): PlatformSettingListResponse {
    return { settings: this.settings.describeAll() };
  }

  /** `GET /api/v1/admin/platform-settings/{key}` — one key. 404 when it is not managed. */
  @Get(':key')
  read(
    @Param(new ZodValidationPipe(PlatformSettingParamsSchema)) params: PlatformSettingParams,
  ): PlatformSettingView {
    try {
      return this.settings.describe(params.key);
    } catch (error: unknown) {
      throw translate(error);
    }
  }

  /**
   * `PUT /api/v1/admin/platform-settings/{key}` — store an override.
   *
   * `PUT` rather than `POST`: the key is the identity of the resource and is in
   * the path, so a repeat with the same body is a no-op on state. `200` rather
   * than `201` for the same reason — the resource is the *setting*, which
   * exists whether or not it has a row, and a caller cannot tell nor need to
   * tell whether this write created one.
   *
   * The response is the new `PlatformSettingView`, which carries the fingerprint
   * and `updatedAt` the console shows as confirmation the value is stored. It
   * does **not** carry a restart notice, because there is no restart: the write
   * is effective on this instance when it answers, and on every other instance
   * within `PLATFORM_SETTINGS_REFRESH_MS`. That bound is what the console tells
   * the operator.
   */
  @Put(':key')
  @HttpCode(HttpStatus.OK)
  async set(
    @Param(new ZodValidationPipe(PlatformSettingParamsSchema)) params: PlatformSettingParams,
    @Body(new ZodValidationPipe(SetPlatformSettingInputSchema)) input: SetPlatformSettingInput,
  ): Promise<PlatformSettingView> {
    try {
      return await this.settings.set(params.key, input.value, this.actorLabel());
    } catch (error: unknown) {
      throw translate(error);
    }
  }

  /**
   * `DELETE /api/v1/admin/platform-settings/{key}` — revert to the environment.
   *
   * `200` with the resulting view rather than `204`: the operator's next
   * question is what the key resolves to *now*, and after a revert that is
   * either the environment's value or nothing at all. A bare `204` would leave
   * them to guess which.
   *
   * Idempotent — reverting a key that has no row reports the state it already
   * had, and writes no history entry, because nothing changed.
   */
  @Delete(':key')
  @HttpCode(HttpStatus.OK)
  async clear(
    @Param(new ZodValidationPipe(PlatformSettingParamsSchema)) params: PlatformSettingParams,
  ): Promise<PlatformSettingView> {
    try {
      return await this.settings.clear(params.key, this.actorLabel());
    } catch (error: unknown) {
      throw translate(error);
    }
  }

  /**
   * `GET /api/v1/admin/platform-settings/{key}/history` — what has happened to
   * this key, newest first.
   *
   * Fingerprints and actor labels; no values, in any form. That is what makes
   * the history safe for anyone with admin access to read, and it is also why
   * there is no rollback action behind it — reverting means re-entering the
   * value, which given its origin is the Meta app dashboard is a lookup rather
   * than a loss.
   */
  @Get(':key/history')
  async history(
    @Param(new ZodValidationPipe(PlatformSettingParamsSchema)) params: PlatformSettingParams,
  ): Promise<PlatformSettingHistoryResponse> {
    try {
      return { changes: await this.settings.history(params.key) };
    } catch (error: unknown) {
      throw translate(error);
    }
  }

  /**
   * The label of the credential that authenticated this request.
   *
   * `PlatformAdminGuard` publishes it before the handler runs, so it is present
   * on every route on this controller. Null would mean the guard did not run —
   * a wiring fault, not a caller error — and writing an unattributed row is
   * worse than refusing, because the trail's whole value is being right about
   * who acted.
   */
  private actorLabel(): string {
    const label = this.tenantContext.platformActorLabel;

    if (label === null) {
      throw new ApiException(
        'internal_error',
        'The platform operator could not be identified for this request.',
      );
    }

    return label;
  }
}

/**
 * The service's failures, in the published taxonomy.
 *
 * Anything not listed is a fault and reaches Nest's default handler as a 500,
 * which is the correct answer for one. No branch here renders a submitted
 * value.
 */
function translate(error: unknown): unknown {
  if (error instanceof UnknownPlatformSettingError) {
    // 404 rather than 400: the path names a resource that does not exist on this
    // platform, and the set of resources is a code-owned allowlist rather than
    // anything the caller could have got right by trying harder.
    return new ApiException('not_found', error.message);
  }

  if (error instanceof PlatformSettingValueInvalidError) {
    return new ApiException('validation_failed', error.message);
  }

  if (error instanceof PlatformSettingsEncryptionUnavailableError) {
    // 500, and the message names the variable. This is a deployment gap rather
    // than a bad request — the operator did nothing wrong and the fix is not
    // theirs to make in the request. This surface is authenticated for the whole
    // platform, so naming the variable leaks nothing.
    return new ApiException('internal_error', error.message);
  }

  return error;
}
