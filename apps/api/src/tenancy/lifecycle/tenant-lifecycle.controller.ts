import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import {
  CursorPageQuerySchema,
  TenantCancelInputSchema,
  TenantDeleteInputSchema,
  type CursorPage,
  type CursorPageQuery,
  type TenantCancelInput,
  type TenantDeleteInput,
  type TenantLifecycleEvent,
  type TenantLifecycleResponse,
} from '@whatsappcrm/contracts';
import { resolveAuditActor } from '../../audit/audit-actor';
import { ApiExceptionFilter } from '../../common/errors/api-exception.filter';
import { AvailableWhileSuspended } from '../../common/request-pipeline/route-access';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { LifecycleEventsRepository } from './lifecycle-events.repository';
import { translateLifecycleFailure } from './lifecycle.http';
import { TenantLifecycleReader } from './tenant-lifecycle.reader';
import { TenantSlugConfirmationError } from './tenant-lifecycle.errors';
import { TenantLifecycleService } from './tenant-lifecycle.service';

/**
 * The tenant's own view of its lifecycle, and the two things its admin may do to
 * it (ADR 0009, endpoint surface).
 *
 * ## Permissions
 *
 * `tenant:settings` reads, `billing:manage` writes. Both are admin-only in
 * `ROLE_PERMISSIONS` today, and deleting a tenant on `billing:manage` rather
 * than a new `tenant:delete` is a deliberate narrowing: the two people who can
 * end a tenant's life are the ones who can end its subscription, and inventing a
 * permission exactly one role holds adds a row to a matrix and no safety.
 *
 * ## `@AvailableWhileSuspended()` on the read
 *
 * `GET /tenant/lifecycle` is on the recovery allowlist because a suspended
 * tenant's admin has to be able to see what happened and when it purges — that
 * is the whole point of a grace period. The writes are **not**: an admin of a
 * suspended tenant cannot cancel or delete it, because both of those are already
 * the direction it is heading and neither needs to be reachable from behind the
 * lockout.
 *
 * `POST /tenant/cancel/undo` is the interesting one. It is not on the allowlist
 * either, and it does not need to be: a `cancelled` tenant still has
 * `apiAccess: false`, so its admin reaches this controller through the allowlist
 * read and undoes the cancellation from... nowhere. That is a real gap in 0009's
 * allowlist as published, and it is closed here by marking the undo route too —
 * the seven-day undo window is unusable otherwise, and the ADR's own Amendment 1
 * ruling 1 argues at length that the window must actually work.
 *
 * ## Why the writes re-read
 *
 * Each write returns `TenantLifecycleResponse`, which carries the plan and the
 * seat usage as well as the status — and those live on the tenant connection
 * while the transition is written on the system one. So the handler transitions
 * and then reads, rather than assembling a response from the write's return
 * value. It is one extra round trip on a route that runs at human speed, and it
 * means the console never renders a plan panel from a half-populated object.
 */
@Controller({ path: 'tenant', version: '1' })
@UseFilters(ApiExceptionFilter)
export class TenantLifecycleController {
  constructor(
    private readonly lifecycle: TenantLifecycleService,
    private readonly reader: TenantLifecycleReader,
    private readonly events: LifecycleEventsRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** `GET /api/v1/tenant/lifecycle` — what the workspace settings plan panel renders. */
  @Get('lifecycle')
  @RequirePermission('tenant:settings')
  @AvailableWhileSuspended()
  async read(): Promise<TenantLifecycleResponse> {
    return await this.reader
      .read(this.tenantContext.requireTenantId())
      .catch((error: unknown) => translateLifecycleFailure(error));
  }

  /**
   * `GET /api/v1/tenant/lifecycle/events` — this tenant's history, newest first.
   *
   * The tenant id comes from the session and never from the request, because
   * `lifecycle_events` carries no row-level security policy for the database to
   * narrow this with. `reason` is not in the response: it is operator free text,
   * and a customer is not who "fraud, card chargeback" is written for.
   */
  @Get('lifecycle/events')
  @RequirePermission('tenant:settings')
  @AvailableWhileSuspended()
  async list(
    @Query(new ZodValidationPipe(CursorPageQuerySchema)) query: CursorPageQuery,
  ): Promise<CursorPage<TenantLifecycleEvent>> {
    return await this.events
      .forTenant(this.tenantContext.requireTenantId(), query)
      .catch((error: unknown) => translateLifecycleFailure(error));
  }

  /**
   * `POST /api/v1/tenant/cancel` — end the subscription, with a grace period.
   *
   * The tenant keeps working for `cancelledGraceDays` and then becomes
   * `suspended`; nothing is destroyed by this call and nothing is destroyed for
   * another month after that.
   */
  @Post('cancel')
  @RequirePermission('billing:manage')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Body(new ZodValidationPipe(TenantCancelInputSchema)) input: TenantCancelInput,
  ): Promise<TenantLifecycleResponse> {
    return await this.transitionAndRead('cancelled', input.reason);
  }

  /**
   * `POST /api/v1/tenant/cancel/undo` — take it back, within the grace period.
   *
   * `cancelled → active` exists for exactly this, and `cancelledGraceDays` is
   * seven because an accidental or regretted cancellation is discovered within a
   * week. Past that the tenant is `suspended` and this route answers `conflict`:
   * the way back from there is a payment or an operator, which is what a
   * suspension means.
   */
  @Post('cancel/undo')
  @RequirePermission('billing:manage')
  @AvailableWhileSuspended()
  @HttpCode(HttpStatus.OK)
  async undoCancel(): Promise<TenantLifecycleResponse> {
    return await this.transitionAndRead('active');
  }

  /**
   * `POST /api/v1/tenant/delete` — **schedules** a deletion; it does not delete.
   *
   * The tenant is cancelled with a grace period, reaches `suspended`, and is
   * purged when `purge_at` elapses — 44 days from here on the published windows.
   * TAR-36's criterion is "when the retention window elapses, then tenant data is
   * permanently deleted", and an endpoint that destroyed data synchronously
   * would have no window for anybody to change their mind in.
   *
   * `confirmSlug` must equal the tenant's own slug, checked here rather than
   * trusted from the client. Typing the name of the thing you are destroying is
   * the cheapest possible guard against the one irreversible action in the
   * product.
   */
  @Post('delete')
  @RequirePermission('billing:manage')
  @HttpCode(HttpStatus.OK)
  async requestDeletion(
    @Body(new ZodValidationPipe(TenantDeleteInputSchema)) input: TenantDeleteInput,
  ): Promise<TenantLifecycleResponse> {
    const tenantId = this.tenantContext.requireTenantId();
    const current = await this.lifecycle
      .state(tenantId)
      .catch((error: unknown) => translateLifecycleFailure(error));

    if (input.confirmSlug !== current.slug) {
      translateLifecycleFailure(new TenantSlugConfirmationError());
    }

    return await this.transitionAndRead('cancelled', input.reason);
  }

  /**
   * The shape all three writes share: transition through the single writer, then
   * read the response back on the tenant connection.
   *
   * The actor is resolved from the request scope rather than passed in — the
   * rule `resolveAuditActor` exists for, and the reason the trail can be trusted
   * about who did what. `user_action` is the trigger on every edge this
   * controller causes, which is what keeps `active → past_due` unreachable from
   * a button: no route here can name a different one.
   */
  private async transitionAndRead(
    to: 'cancelled' | 'active',
    reason?: string,
  ): Promise<TenantLifecycleResponse> {
    const tenantId = this.tenantContext.requireTenantId();

    await this.lifecycle
      .transition({
        tenantId,
        to,
        trigger: 'user_action',
        actor: resolveAuditActor(this.tenantContext),
        reason,
      })
      .catch((error: unknown) => translateLifecycleFailure(error));

    return await this.reader
      .read(tenantId)
      .catch((error: unknown) => translateLifecycleFailure(error));
  }
}
