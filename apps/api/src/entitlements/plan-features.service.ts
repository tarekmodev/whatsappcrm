import { Inject, Injectable } from '@nestjs/common';
import type { PlanFeature } from '@whatsappcrm/contracts';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';

/**
 * Whether the tenant's plan includes a boolean capability — the read half of the
 * `FeatureGuard` 0002 puts at slot 6 of the request pipeline and TAR-37 owns.
 *
 * ## Why this exists now, and what it deliberately is not
 *
 * TAR-28 needs one feature checked (`ai_chatbot`) on two routes and in one
 * worker, and the guard TAR-37 will write does not exist yet. Building the guard
 * here would be this story deciding the shape of another story's request
 * pipeline; building nothing would ship a feature gate that is documented and
 * absent. So this is the **reader only**: one method, on the column the schema
 * already has, that a guard can later be written in front of without any call
 * site changing.
 *
 * ## `plans.entitlements` is the source, and an absent answer grants
 *
 * The column is JSONB precisely so adding an entitlement is a data change rather
 * than a migration, and a plan that names the feature is honoured in both
 * directions — `true` grants, `false` refuses.
 *
 * **A tenant with no subscription, or on a plan whose `entitlements` does not
 * mention the feature, is granted it.** That is a decision rather than an
 * oversight, and the same one `PlanLimitsService` records for a missing
 * `tenant_plan_limits` row: every tenant provisioned by an operator today has no
 * `subscriptions` row at all, and no seeded plan carries feature flags yet
 * (`DEMO_PLANS` publishes `seats` and `conversationsPerPeriod` and nothing
 * else). Failing closed would make this gate refuse every tenant on the
 * platform, which is a feature that reads as shipped and never works.
 *
 * It is also the correct failure direction on the merits: a plan gate is a
 * commercial ceiling, not a security boundary. Tenant isolation is RLS's job and
 * is unaffected either way, and the isolation this story does own — the empty
 * knowledge base rule — is enforced separately and fails **closed**
 * (`BotEligibilityService`), so a tenant granted the feature by this default
 * still cannot receive an automated reply without a knowledge base of their own.
 *
 * When TAR-37 lands with real plan data, the entitlement rows become the
 * authority and this default stops being reachable for any tenant it has priced.
 */
@Injectable()
export class PlanFeaturesService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  /**
   * One indexed read on `subscriptions`, plus the plan it names.
   *
   * Not cached. It runs once per config read and once per bot turn — human-speed
   * and worker-speed respectively — and a cached entitlement is a permission
   * check that keeps saying yes after a downgrade, which is the one kind of
   * staleness a gate must not have.
   */
  async includes(feature: PlanFeature): Promise<boolean> {
    const subscription = await this.prisma.subscription.findFirst({
      select: { plan: { select: { entitlements: true } } },
    });

    return readFeatureFlag(subscription?.plan.entitlements, feature) ?? true;
  }
}

/**
 * The flag as the plan states it, or `null` when the plan says nothing about it.
 *
 * `null` rather than `false` for the unstated case, because "this plan does not
 * include the feature" and "this plan has no opinion" are different facts and
 * only the caller knows which default applies to which.
 *
 * Defensive about the shape because the column is JSONB: it can hold an array, a
 * string, or an object whose value for this key is a number somebody typed by
 * hand. Only a real boolean is read as an answer.
 */
function readFeatureFlag(entitlements: unknown, feature: PlanFeature): boolean | null {
  if (typeof entitlements !== 'object' || entitlements === null || Array.isArray(entitlements)) {
    return null;
  }

  const value = (entitlements as Record<string, unknown>)[feature];

  return typeof value === 'boolean' ? value : null;
}
