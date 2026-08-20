import { Inject, Injectable } from '@nestjs/common';
import type { TenantLifecycleResponse } from '@whatsappcrm/contracts';
import { PlanLimitsService } from '../../entitlements/plan-limits.service';
import { UsageCounterService } from '../../entitlements/usage-counter.service';
import { TENANT_PRISMA, type TenantPrisma } from '../../prisma/prisma.tokens';
import { TenantNotFoundError } from '../tenant-deactivation.errors';

/**
 * Assembles `GET /api/v1/tenant/lifecycle` — the plan panel's whole response
 * (ADR 0009, TAR-409).
 *
 * ## Why this is separate from `TenantLifecycleService`
 *
 * They read through different clients, and that is not an accident of layering.
 * The lifecycle columns live on `tenants`, which carries no row-level security
 * policy and is `SystemPrisma`'s; the plan and the usage live in
 * `tenant_entitlements`, `users`, `invites` and `usage_counters`, every one of
 * which is RLS-scoped and must be read on the **tenant** connection so the rows
 * this response counts are the ones the caller's own tenant holds.
 *
 * Folding both into the writer would have put an unscoped read of four
 * tenant-scoped tables inside the class that already holds the widest write
 * permission in the tenancy module. Splitting them means the seat count a tenant
 * sees is one the database itself narrowed.
 *
 * ## One transaction, one connection
 *
 * All four reads run inside a single `$tenantTransaction`, which sets the GUC
 * once rather than once per statement — and, more importantly, means the four
 * numbers describe one instant. A seat count and a cap read a moment apart can
 * disagree, and "3 of 3" beside a refusal the admin did not get is exactly the
 * confusion ruling 3 exists to prevent.
 *
 * ## It works while the tenant is suspended or cancelled
 *
 * Deliberately, and it is the reason the route is on the recovery allowlist:
 * `assert_tenant_serviceable` admits both states, so an admin locked out of the
 * rest of the product can still see what happened to their workspace and when it
 * purges. That is the whole point of a seven-day undo window.
 */
@Injectable()
export class TenantLifecycleReader {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly planLimits: PlanLimitsService,
    private readonly usage: UsageCounterService,
  ) {}

  async read(tenantId: string): Promise<TenantLifecycleResponse> {
    return await this.prisma.$tenantTransaction(async (tx) => {
      // `Tenant` is not narrowed inside a transaction — the extension's model
      // policies apply per statement outside one — so the id is restated by
      // hand. It is the tenant the guard resolved, never anything the request
      // carried.
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true, trialEndsAt: true, gracePeriodEndsAt: true, purgeAt: true },
      });

      if (tenant === null) {
        throw new TenantNotFoundError(tenantId);
      }

      const plan = await this.planLimits.effectiveEntitlements(tx);
      const seats = await this.planLimits.seatUsage(tx);
      const conversations = await this.usage.current(tx, {
        tenantId,
        metric: 'conversations_opened',
      });

      return {
        status: tenant.status,
        trialEndsAt: tenant.trialEndsAt?.toISOString() ?? null,
        gracePeriodEndsAt: tenant.gracePeriodEndsAt?.toISOString() ?? null,
        purgeAt: tenant.purgeAt?.toISOString() ?? null,
        plan,
        usage: { ...seats, conversationsThisPeriod: conversations.value },
      };
    });
  }
}
