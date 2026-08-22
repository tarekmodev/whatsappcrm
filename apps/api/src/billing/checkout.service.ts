import { Inject, Injectable } from '@nestjs/common';
import {
  BILLING_PROVIDER,
  type BillingProvider,
  type CheckoutRequest,
  type HostedSession,
  type PortalRequest,
} from '@whatsappcrm/contracts';
import { PlanLimitsService } from '../entitlements/plan-limits.service';
import { UsageCounterService } from '../entitlements/usage-counter.service';
import { TenantLinkService } from '../identity/mailer/tenant-link.service';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import {
  BillingProviderUnavailableError,
  NoSubscriptionError,
  PlanDowngradeBlockedError,
  PlanNotFoundError,
} from './billing.errors';

/** Where the console lands when the provider sends the browser back. */
const DEFAULT_SUCCESS_PATH = '/settings/billing?checkout=success';
const DEFAULT_CANCEL_PATH = '/settings/billing?checkout=cancelled';
const DEFAULT_RETURN_PATH = '/settings/billing';

/**
 * Opening a checkout, and opening the customer portal.
 *
 * Applying a purchase is **not** here: the provider webhook is the one path that
 * writes a subscription (`BillingWebhookService` → `SubscriptionSyncService`).
 * TAR-619 chose the webhook plus a refresh over a client-side completion call on
 * return from the hosted page, and TAR-651 removed the endpoint that offered the
 * second path, so there is exactly one writer.
 *
 * ## Return URLs are composed here, never taken from the caller
 *
 * `CheckoutRequest` carries **paths**, and this composes them against the host
 * the control plane holds for the tenant. A payment provider redirects the
 * browser to whatever `success_url` it is handed, so an absolute URL from a
 * client would be an open redirect with a payment page in front of it — the one
 * screen where a user is most primed to trust where they land. `TenantLinkService`
 * is the single resolver for that rule, shared with the one that keeps a
 * password-reset token from being aimed at an attacker's server.
 *
 * ## A downgrade is refused before the money moves
 *
 * `GET /billing/plans` already marks a plan `isSelectable: false` when its
 * ceilings sit below the tenant's live usage, and the console disables the
 * button. This checks again, because the console disabling a button is a
 * courtesy and the API refusing the request is the enforcement — a tenant that
 * paid for a plan it is already over would then be refused its next invite, with
 * an invoice in hand.
 *
 * ## Seats default to what is already held, and never fall below it
 *
 * Checking out for fewer seats than are in use would create a subscription that
 * is over its own cap the moment it activates.
 */
@Injectable()
export class CheckoutService {
  constructor(
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly planLimits: PlanLimitsService,
    private readonly usage: UsageCounterService,
    private readonly links: TenantLinkService,
  ) {}

  /**
   * `POST /api/v1/billing/checkout` — the hosted page to redirect to.
   *
   * Wrapped in an `Idempotency-Key` by the controller: it is a `POST` with an
   * external side effect, so a double-click must not open two checkout sessions
   * against the same card.
   */
  async createCheckout(tenantId: string, input: CheckoutRequest): Promise<HostedSession> {
    const plan = await this.prisma.$tenantTransaction(async (tx) => {
      const row = await tx.plan.findFirst({
        where: { key: input.planKey, isActive: true },
        // `providerProductId` is read here and passed straight through to the
        // adapter. It is opaque: nothing in this file interprets it, and it
        // never reaches a response.
        select: { key: true, providerProductId: true, entitlements: true },
      });

      if (row === null) {
        throw new PlanNotFoundError(input.planKey);
      }

      const seatsHeld = await this.planLimits
        .seatUsage(tx)
        .then(({ seatsUsed, seatsPending }) => seatsUsed + seatsPending);
      const conversations = await this.usage.current(tx, {
        tenantId,
        metric: 'conversations_opened',
      });

      assertPlanFits(row.entitlements, seatsHeld, conversations.value);

      return {
        key: row.key,
        providerProductId: row.providerProductId,
        // Never below what is already held, whatever the caller asked for.
        seats: Math.max(input.seats ?? seatsHeld, seatsHeld, 1),
      };
    });

    return await this.provider.createCheckout({
      tenantId,
      planKey: plan.key,
      seats: plan.seats,
      successUrl: await this.absoluteUrl(input.successPath ?? DEFAULT_SUCCESS_PATH),
      cancelUrl: await this.absoluteUrl(input.cancelPath ?? DEFAULT_CANCEL_PATH),
      providerProductId: plan.providerProductId,
    });
  }

  /**
   * `POST /api/v1/billing/portal` — a short-lived provider-hosted session for
   * invoices, payment method, plan change and cancellation.
   *
   * **Never stored.** A portal URL is a live credential for somebody's billing
   * account, and one cached in a column is one that outlives the click that
   * needed it. No idempotency key either: a portal session is free to create and
   * has no side effect worth replaying, and requiring a key on the "manage
   * billing" button is friction for nothing.
   *
   * A tenant that has never completed a checkout has no provider-side customer
   * to open a portal for, so this answers `not_found` and the console offers
   * checkout instead.
   */
  async createPortalSession(tenantId: string, input: PortalRequest): Promise<HostedSession> {
    const subscription = await this.prisma.subscription.findFirst({
      select: { providerCustomerId: true },
    });

    if (subscription?.providerCustomerId == null) {
      throw new NoSubscriptionError();
    }

    return await this.provider.createPortalSession({
      tenantId,
      returnUrl: await this.absoluteUrl(input.returnPath ?? DEFAULT_RETURN_PATH),
    });
  }

  /**
   * A console path made absolute against the tenant's own host.
   *
   * A tenant with no deliverable domain has nowhere legitimate to send the
   * browser back to, and inventing one is exactly what this rule exists to
   * prevent — so checkout is refused rather than opened with a guess.
   */
  private async absoluteUrl(path: string): Promise<string> {
    const url = await this.links.absoluteUrl(path);

    if (url === null) {
      throw new BillingProviderUnavailableError(
        `no deliverable domain to compose a return URL from (path ${path})`,
      );
    }

    return url;
  }
}

/**
 * Refuses a plan whose ceilings sit below what the tenant is already using.
 *
 * Reads the ceilings off the raw catalogue JSON rather than through
 * `PlanEntitlementsSchema`, for the same reason `PlanLimitsService.limitOf`
 * does: a value that is not a positive integer is treated as no ceiling, and a
 * hand-edited row must not be able to refuse a legitimate purchase.
 */
function assertPlanFits(
  entitlements: unknown,
  seatsHeld: number,
  conversationsThisPeriod: number,
): void {
  const limits = (entitlements as { limits?: Record<string, unknown> } | null)?.limits ?? {};

  const seatCap = positiveIntegerOrNull(limits.seats);

  if (seatCap !== null && seatCap < seatsHeld) {
    throw new PlanDowngradeBlockedError('seats', seatCap, seatsHeld);
  }

  const conversationCap = positiveIntegerOrNull(limits.conversationsPerPeriod);

  if (conversationCap !== null && conversationCap < conversationsThisPeriod) {
    throw new PlanDowngradeBlockedError(
      'conversationsPerPeriod',
      conversationCap,
      conversationsThisPeriod,
    );
  }
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
