import { Inject, Injectable } from '@nestjs/common';
import {
  PlanEntitlementsSchema,
  type BillingSummaryResponse,
  type Plan,
  type PlanListResponse,
  type UsageSummaryResponse,
} from '@whatsappcrm/contracts';
import { PlanLimitsService } from '../entitlements/plan-limits.service';
import { UsageCounterService } from '../entitlements/usage-counter.service';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';

/**
 * The metrics `GET /billing/usage` reports, and the order it reports them in.
 *
 * Deliberately not every member of `USAGE_METRICS`. The panel answers "what am I
 * being charged for and how close am I to a limit"; `messages_sent`,
 * `messages_received` and `ai_replies` are recorded from day one because they
 * are real costs, but neither is metered against a ceiling at v1 and listing
 * them beside two that are would read as four limits.
 */
const REPORTED_METRICS = ['seats_active', 'conversations_opened'] as const;

/**
 * Assembles the three billing reads — the plans view, the subscription summary
 * and the usage panel.
 *
 * ## Every read is on the tenant connection, in one transaction
 *
 * `subscriptions`, `tenant_entitlements`, `users`, `invites` and
 * `usage_counters` are all RLS-scoped, so the rows this returns are the ones the
 * database itself narrowed to the caller's tenant — the same shape
 * `TenantLifecycleReader` uses and for the same reason. `plans` is the exception
 * and is read through the same connection under `MODEL_POLICIES`'
 * `shared-read-only` rule: it is a platform-wide catalogue with no tenant column
 * and nothing secret in it.
 *
 * One `$tenantTransaction` per response rather than a query each, so the numbers
 * describe one instant. A seat count and a cap read a moment apart can disagree,
 * and "3 of 3" beside a refusal the admin did not get is exactly the confusion
 * this avoids.
 *
 * ## It works while the tenant is suspended or cancelled
 *
 * Deliberately, and it is why the routes are on the recovery allowlist:
 * `assert_tenant_serviceable` admits both states, so an admin locked out of the
 * product can still see what they are on and reach checkout. A suspended tenant
 * whose admin cannot reach billing cannot pay its way out.
 */
@Injectable()
export class BillingReaderService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly planLimits: PlanLimitsService,
    private readonly usage: UsageCounterService,
  ) {}

  /**
   * `GET /api/v1/billing/plans` — every purchasable tier, with this tenant's
   * position in it.
   *
   * `isSelectable` and `blockedBy` are computed **server-side** rather than left
   * to the console, because they depend on live usage the client does not hold.
   * A downgrade that would leave a tenant over its own new cap is refused before
   * checkout rather than after payment — the console disables the button, and
   * `CheckoutService` refuses it again if the button is bypassed.
   */
  async plans(tenantId: string): Promise<PlanListResponse> {
    return await this.prisma.$tenantTransaction(async (tx) => {
      const rows = await tx.plan.findMany({
        // Withdrawn tiers are hidden from the list; a tenant already on one keeps
        // it, which `BillingSummaryResponse.plan` reports separately.
        where: { isActive: true },
        select: PLAN_PROJECTION,
        orderBy: { priceMinorUnits: 'asc' },
      });

      const current = await tx.tenantEntitlements.findFirst({ select: { planKey: true } });
      const seats = await this.planLimits.seatUsage(tx);
      const conversations = await this.usage.current(tx, {
        tenantId,
        metric: 'conversations_opened',
      });

      const seatsHeld = seats.seatsUsed + seats.seatsPending;

      return {
        plans: rows.map((row) => {
          const plan = toPlan(row);
          const blockedBy = blockingLimits(plan, seatsHeld, conversations.value);

          return {
            ...plan,
            isCurrent: current?.planKey === plan.key,
            isSelectable: blockedBy.length === 0,
            blockedBy,
          };
        }),
        usage: {
          ...seats,
          conversationsThisPeriod: conversations.value,
        },
      };
    });
  }

  /** `GET /api/v1/billing/subscription` — what the billing settings page renders. */
  async summary(tenantId: string): Promise<BillingSummaryResponse> {
    return await this.prisma.$tenantTransaction(async (tx) => {
      const subscription = await tx.subscription.findFirst({
        select: {
          id: true,
          tenantId: true,
          status: true,
          seats: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          cancelsAt: true,
          createdAt: true,
          updatedAt: true,
          plan: { select: PLAN_PROJECTION },
        },
      });

      // The **enforced** entitlements, not the catalogue's. They are normally
      // the same — `SubscriptionSyncService` copies one onto the other — and
      // where they differ it is because an operator hand-adjusted a tenant, and
      // the number that is actually enforced is the one to show.
      const effective = await this.planLimits.effectiveEntitlements(tx);
      const seats = await this.planLimits.seatUsage(tx);
      const conversations = await this.usage.current(tx, {
        tenantId,
        metric: 'conversations_opened',
      });

      return {
        // `SubscriptionSchema` requires both period bounds, so a row without
        // them is reported as no subscription rather than as one with invented
        // dates. It is a real state — the row exists from the moment a webhook
        // names a plan, and the provider may not have set a period yet — and the
        // `plan` below is still returned, so the console renders "you are on
        // Growth" without a billing period it would have to make up.
        subscription:
          subscription === null ||
          subscription.currentPeriodStart === null ||
          subscription.currentPeriodEnd === null
            ? null
            : {
                id: subscription.id,
                tenantId: subscription.tenantId,
                planKey: subscription.plan.key,
                status: subscription.status,
                seats: subscription.seats,
                currentPeriodStart: subscription.currentPeriodStart.toISOString(),
                currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
                cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                // Never populated by this platform: trials live on
                // `tenants.trial_ends_at`, which the lifecycle owns. Restating
                // it here would give the console two clocks for one deadline.
                trialEndsAt: null,
                createdAt: subscription.createdAt.toISOString(),
                updatedAt: subscription.updatedAt.toISOString(),
              },
        plan: subscription === null ? null : toPlan(subscription.plan),
        entitlements: effective.entitlements,
        usage: { ...seats, conversationsThisPeriod: conversations.value },
        cancelsAt: subscription?.cancelsAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * `GET /api/v1/billing/usage` — the counters, each against the ceiling that
   * applies to it.
   *
   * The period is the **subscription's**, resolved by `UsagePeriodResolver`, so a
   * counter can never straddle two invoices. A tenant with no subscription falls
   * back to the anniversary-monthly window on `tenants.created_at`, which is what
   * gives a trialing tenant a period at all.
   */
  async usageSummary(tenantId: string): Promise<UsageSummaryResponse> {
    return await this.prisma.$tenantTransaction(async (tx) => {
      const { entitlements } = await this.planLimits.effectiveEntitlements(tx);
      const seats = await this.planLimits.seatUsage(tx);
      const conversations = await this.usage.current(tx, {
        tenantId,
        metric: 'conversations_opened',
      });

      return {
        period: {
          start: conversations.period.start.toISOString(),
          end: conversations.period.end.toISOString(),
        },
        counters: REPORTED_METRICS.map((metric) =>
          metric === 'seats_active'
            ? {
                metric,
                // A gauge, and read from the same function the invite check
                // enforces on rather than from `usage_counters`: the panel and
                // the refusal must not be able to disagree about how many seats
                // are in use.
                value: seats.seatsUsed + seats.seatsPending,
                limit: entitlements.limits.seats,
              }
            : {
                metric,
                value: conversations.value,
                limit: entitlements.limits.conversationsPerPeriod,
              },
        ),
      };
    });
  }
}

/**
 * Which of the plan's ceilings sit below what the tenant is already using.
 *
 * Only the two the console can act on: seats and conversation volume. A tenant
 * over a plan's WhatsApp-number or team ceiling is a real conflict too, but it
 * is one an admin cannot resolve from the plans page and `PlanListResponse`
 * deliberately does not offer a vocabulary for it. `null` is unlimited and
 * blocks nothing.
 */
function blockingLimits(
  plan: Plan,
  seatsHeld: number,
  conversationsThisPeriod: number,
): ('seats' | 'conversationsPerPeriod')[] {
  const blocked: ('seats' | 'conversationsPerPeriod')[] = [];

  if (plan.entitlements.limits.seats !== null && plan.entitlements.limits.seats < seatsHeld) {
    blocked.push('seats');
  }

  if (
    plan.entitlements.limits.conversationsPerPeriod !== null &&
    plan.entitlements.limits.conversationsPerPeriod < conversationsThisPeriod
  ) {
    blocked.push('conversationsPerPeriod');
  }

  return blocked;
}

/**
 * A `plans` row as `PlanSchema` publishes it.
 *
 * `provider_product_id` and `provider_price_id` are **not** in the projection
 * and could not be mapped if they were: they are the provider's opaque ids, they
 * are not on `PlanSchema`, and a plans endpoint that returned them would put a
 * Polar identifier on a tenant-facing wire for no reason.
 *
 * A row whose `entitlements` do not parse is reported as having none rather than
 * throwing. `plans_entitlements_shape` refuses every malformed shape at write
 * time so this is unreachable, and a hand-edited catalogue row must not be able
 * to take the pricing page down.
 */
function toPlan(row: PlanRow): Plan {
  const entitlements = PlanEntitlementsSchema.safeParse(row.entitlements);

  return {
    id: row.id,
    key: row.key,
    name: row.name,
    pricePerSeat: { amountMinor: row.priceMinorUnits, currency: row.currency },
    interval: row.interval,
    entitlements: entitlements.success ? entitlements.data : { features: [], limits: EMPTY_LIMITS },
    // **`PlanSchema.isPublic` has no column behind it.** The schema TAR-617
    // landed carries `is_active` only, and the two are not the same distinction:
    // `is_active` is "may still be subscribed to", `is_public` is "shown on the
    // pricing page". Reported as `is_active` because that is the closest true
    // statement available, and the practical effect is identical today — every
    // active plan is listed. Splitting them is a column and a migration, and it
    // belongs to whoever first needs a tier that is buyable but unlisted.
    isPublic: row.isActive,
  };
}

const EMPTY_LIMITS = {
  seats: null,
  conversationsPerPeriod: null,
  whatsappNumbers: null,
  teams: null,
  knowledgeDocuments: null,
} as const;

const PLAN_PROJECTION = {
  id: true,
  key: true,
  name: true,
  priceMinorUnits: true,
  currency: true,
  interval: true,
  entitlements: true,
  isActive: true,
} as const satisfies Prisma.PlanSelect;

interface PlanRow {
  id: string;
  key: string;
  name: string;
  priceMinorUnits: number;
  currency: string;
  interval: 'month' | 'year';
  entitlements: Prisma.JsonValue;
  isActive: boolean;
}
