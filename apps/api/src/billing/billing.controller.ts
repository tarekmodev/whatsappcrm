import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import {
  CheckoutRequestSchema,
  PortalRequestSchema,
  type BillingSummaryResponse,
  type CheckoutRequest,
  type HostedSession,
  type PlanListResponse,
  type PortalRequest,
  type UsageSummaryResponse,
} from '@whatsappcrm/contracts';
import { z } from 'zod';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { AvailableWhileSuspended } from '../common/request-pipeline/route-access';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { BillingReaderService } from './billing-reader.service';
import { translateBillingFailure } from './billing.http';
import { CheckoutService } from './checkout.service';

/** Lower-case, because Express lower-cases every header name it indexes. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Namespaces the idempotency hash, so one key cannot replay across two endpoints. */
const CHECKOUT_OPERATION = 'billing.checkout';

/**
 * The provider's checkout id, handed back on the redirect. Bounded and opaque —
 * it is only ever passed to the adapter, never interpreted here.
 */
const CheckoutReturnQuerySchema = z.object({
  checkoutId: z.string().min(1).max(200),
});

type CheckoutReturnQuery = z.infer<typeof CheckoutReturnQuerySchema>;

/**
 * The tenant's billing surface (TAR-37, ADR 0002's endpoint table plus
 * `GET /billing/plans`).
 *
 * It declares no guards. `RequestPipelineModule` runs all three on every route
 * in the application — where the request is, who is making it, then whether they
 * may — so every route below states only its permission.
 *
 * ## Permissions
 *
 * `billing:read` on the three reads, `billing:manage` on the two writes. Both
 * are admin-only in `ROLE_PERMISSIONS`, and the split is the one that matters:
 * an admin who can see what the workspace is paying is not automatically one who
 * can change it, which is what makes `billing:manage` worth being a separate
 * permission rather than a synonym.
 *
 * ## Every route is `@AvailableWhileSuspended()`
 *
 * `TENANT_STATUS_EFFECTS.suspended` sets `apiAccess: false` precisely so the
 * allowlist is the deliberate exception, and this is the exception it exists
 * for: **a suspended tenant whose admin cannot reach checkout cannot pay its way
 * out.** The decorator never opens a route to an agent or a supervisor — the
 * exemption is conditional on holding `admin` — so what it admits is exactly the
 * person who can fix the situation.
 *
 * ## Why checkout needs an idempotency key and portal does not
 *
 * Checkout is a `POST` with an external side effect: a double-click must not
 * open two sessions against the same card, which is what ADR 0002 requires a key
 * for. A portal session is short-lived, free to create and has no side effect
 * worth replaying, so requiring a key on the "manage billing" button would be
 * friction for nothing.
 */
@Controller({ path: 'billing', version: '1' })
@UseFilters(ApiExceptionFilter)
export class BillingController {
  constructor(
    private readonly reader: BillingReaderService,
    private readonly checkout: CheckoutService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** `GET /api/v1/billing/plans` — the tiers, with this tenant's position in them. */
  @Get('plans')
  @RequirePermission('billing:read')
  @AvailableWhileSuspended()
  async plans(): Promise<PlanListResponse> {
    return await this.reader
      .plans(this.tenantContext.requireTenantId())
      .catch((error: unknown) => translateBillingFailure(error));
  }

  /** `GET /api/v1/billing/subscription` — the billing settings page. */
  @Get('subscription')
  @RequirePermission('billing:read')
  @AvailableWhileSuspended()
  async subscription(): Promise<BillingSummaryResponse> {
    return await this.reader
      .summary(this.tenantContext.requireTenantId())
      .catch((error: unknown) => translateBillingFailure(error));
  }

  /** `GET /api/v1/billing/usage` — the counters, each against its ceiling. */
  @Get('usage')
  @RequirePermission('billing:read')
  @AvailableWhileSuspended()
  async usage(): Promise<UsageSummaryResponse> {
    return await this.reader
      .usageSummary(this.tenantContext.requireTenantId())
      .catch((error: unknown) => translateBillingFailure(error));
  }

  /**
   * `POST /api/v1/billing/checkout` — opens a hosted checkout session.
   *
   * The `Idempotency-Key` header is **required**, and its absence is a
   * validation failure rather than a silently unprotected request: this is the
   * one route in the module that costs the customer money, and a client that
   * forgot the header would otherwise be one double-click from two
   * subscriptions.
   */
  @Post('checkout')
  @RequirePermission('billing:manage')
  @AvailableWhileSuspended()
  @HttpCode(HttpStatus.OK)
  async createCheckout(
    @Body(new ZodValidationPipe(CheckoutRequestSchema)) input: CheckoutRequest,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ): Promise<HostedSession> {
    const tenantId = this.tenantContext.requireTenantId();

    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      throw new ApiException('validation_failed', 'An Idempotency-Key header is required.', [
        { path: 'Idempotency-Key', message: 'required for this operation' },
      ]);
    }

    const outcome = await this.idempotency
      .execute<HostedSession>(
        {
          key: idempotencyKey,
          operation: CHECKOUT_OPERATION,
          // The plan is what the key is scoped to: retrying "upgrade me to
          // growth" is a replay, while the same key against a different plan is
          // a client bug and answers `idempotency_key_reused`.
          target: input.planKey,
          payload: input,
          statusCode: HttpStatus.OK,
        },
        async () => await this.checkout.createCheckout(tenantId, input),
      )
      .catch((error: unknown) => translateBillingFailure(error));

    return outcome.body;
  }

  /**
   * `POST /api/v1/billing/portal` — a short-lived link into the provider's own
   * customer portal for invoices, payment method, plan change and cancellation.
   *
   * Generated on every click and never stored: a portal URL is a live credential
   * for somebody's billing account.
   */
  @Post('portal')
  @RequirePermission('billing:manage')
  @AvailableWhileSuspended()
  @HttpCode(HttpStatus.OK)
  async createPortalSession(
    @Body(new ZodValidationPipe(PortalRequestSchema)) input: PortalRequest,
  ): Promise<HostedSession> {
    return await this.checkout
      .createPortalSession(this.tenantContext.requireTenantId(), input)
      .catch((error: unknown) => translateBillingFailure(error));
  }

  /**
   * `POST /api/v1/billing/checkout/complete` — applies a checkout the browser
   * has just returned from, so the console reflects the purchase immediately.
   *
   * **The fast path, not the authoritative one.** The webhook is authoritative,
   * and both are safe to apply in either order because
   * `subscriptions.last_event_at` drops whichever carries the older provider
   * timestamp. The redirect usually lands before the delivery does, and without
   * this the tenant would pay and then watch an unchanged plan panel for as long
   * as delivery took.
   *
   * No idempotency key: the operation is already idempotent by construction, and
   * a caller may repeat it by refreshing.
   *
   * ⚠️ **Nothing calls this yet.** TAR-619 shipped the return page against
   * `?checkout=succeeded` plus a link back, deliberately preferring the webhook
   * and a manual refresh to a client-side poll — so the console never sends a
   * checkout id. The route exists because `BillingProvider.resolveCheckout` is
   * part of the published port and this is the only thing that exercises it: the
   * contract's stated intent is that the console reflects the purchase on return
   * rather than seconds later, and adopting it is one line in
   * `billing.actions.ts`. If the Architect confirms the webhook-only return is
   * the intended shape, this route and `resolveCheckout` should both go — that
   * is a contract decision, not one to make quietly here.
   */
  @Post('checkout/complete')
  @RequirePermission('billing:manage')
  @AvailableWhileSuspended()
  @HttpCode(HttpStatus.OK)
  async completeCheckout(
    @Query(new ZodValidationPipe(CheckoutReturnQuerySchema)) query: CheckoutReturnQuery,
  ): Promise<BillingSummaryResponse> {
    const tenantId = this.tenantContext.requireTenantId();

    await this.checkout
      .applyCompletedCheckout(tenantId, query.checkoutId)
      .catch((error: unknown) => translateBillingFailure(error));

    // Re-read rather than assembling a response from the write: the summary
    // carries the plan, the entitlements and live usage, and the console must
    // never render a plan panel from a half-populated object.
    return await this.reader
      .summary(tenantId)
      .catch((error: unknown) => translateBillingFailure(error));
  }
}
