import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  PasswordChangeInputSchema,
  PasswordResetConfirmInputSchema,
  PasswordResetRequestInputSchema,
  type PasswordChangeInput,
  type PasswordResetConfirmInput,
  type PasswordResetRequestInput,
} from '@whatsappcrm/contracts';
import { isIP } from 'node:net';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { PermissionGuard } from '../rbac/permission.guard';
import { PrincipalGuard } from '../rbac/principal.guard';
import { AnyPrincipal } from '../rbac/require-permission.decorator';
import { HostTenantGuard } from '../tenancy/host-tenant.guard';
import { translateIdentityFailure } from './identity.http';
import { PasswordChangeService } from './password-change.service';
import { PasswordResetService } from './password-reset.service';

/**
 * Password recovery and change (TAR-57), on TAR-53's published paths.
 *
 * **Guards are declared per route here, not on the controller**, which is a
 * deliberate departure from `UsersController`'s pattern: two of these three
 * routes are reachable by design without a session, and a controller-wide
 * `PrincipalGuard` with a per-route opt-out would make "this endpoint is public"
 * the absence of a line rather than the presence of one. Every route below says
 * what it requires.
 *
 * `HostTenantGuard` is on all three regardless. Even a public endpoint runs with
 * the tenant in scope — it is what puts the `app.tenant_id` GUC in place, so
 * every query in the reset flow is filtered by RLS exactly like an authenticated
 * one (TAR-53, amendment 1).
 *
 * Separate from the login/session controller TAR-56 adds on the same `auth`
 * path prefix. Nest routes both, and two files that ship independently do not
 * collide.
 */
@Controller({ path: 'auth', version: '1' })
@UseFilters(ApiExceptionFilter)
export class PasswordController {
  constructor(
    private readonly resets: PasswordResetService,
    private readonly changes: PasswordChangeService,
  ) {}

  /**
   * `POST /api/v1/auth/password-reset` — ask for a link.
   *
   * **Always 204**, whether or not the address has an account, whether or not it
   * is active, and whether or not the request was throttled. Anything else turns
   * this into a way to ask "does this person work here", which is a question an
   * unauthenticated caller should not be able to have answered.
   */
  @Post('password-reset')
  @UseGuards(HostTenantGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async requestReset(
    @Body(new ZodValidationPipe(PasswordResetRequestInputSchema))
    input: PasswordResetRequestInput,
    @Ip() ip: string,
  ): Promise<void> {
    await this.resets.request(input, forensicIp(ip));
  }

  /** `POST /api/v1/auth/password-reset/confirm` — redeem it, once. */
  @Post('password-reset/confirm')
  @UseGuards(HostTenantGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmReset(
    @Body(new ZodValidationPipe(PasswordResetConfirmInputSchema))
    input: PasswordResetConfirmInput,
  ): Promise<void> {
    await this.resets.confirm(input).catch(translateIdentityFailure);
  }

  /**
   * `POST /api/v1/auth/password` — change your own.
   *
   * `@AnyPrincipal()` rather than a permission: the resource *is* the caller, and
   * no role gates changing your own password. Stated out loud because
   * `PermissionGuard` refuses a route carrying no metadata at all, so "this one
   * needs nothing" is a decision a reviewer can see rather than a missing line.
   */
  @Post('password')
  @UseGuards(HostTenantGuard, PrincipalGuard, PermissionGuard)
  @AnyPrincipal()
  @HttpCode(HttpStatus.NO_CONTENT)
  async change(
    @Body(new ZodValidationPipe(PasswordChangeInputSchema)) input: PasswordChangeInput,
  ): Promise<void> {
    await this.changes.change(input).catch(translateIdentityFailure);
  }
}

/**
 * The caller's address, or `null` when it is not one an `inet` column will take.
 *
 * `password_reset_tokens.requested_ip` is `inet`, and Postgres rejects anything
 * that is not an address — so an unparseable value would turn a reset request
 * into a 500, which is both a worse answer and an enumeration signal. It is
 * forensics, never a filter and never shown to a user, so dropping it is the
 * right trade when it cannot be trusted.
 */
function forensicIp(ip: string | undefined): string | null {
  return ip !== undefined && isIP(ip) !== 0 ? ip : null;
}
