import { Module } from '@nestjs/common';
import { PlanLimitsService } from './plan-limits.service';
import { UsageCounterService } from './usage-counter.service';
import { UsagePeriodResolver } from './usage-period.resolver';

/**
 * Plan entitlements and the write-time enforcement of them (TAR-405).
 *
 * A module of its own rather than providers added to `TenancyModule` or
 * `IdentityModule`, because this is the seam TAR-37 re-points: when real
 * Polar.sh plans arrive, the source of a limit changes here and every
 * enforcement site keeps calling the same method. A limit check folded into
 * whichever module happened to need it first would have to be found in three
 * places instead.
 *
 * `PlanLimitsService` holds no state and reads `TenantPrisma` from the global
 * `PrismaModule`, so there is nothing to import.
 */
@Module({
  providers: [PlanLimitsService, UsageCounterService, UsagePeriodResolver],
  // `UsageCounterService` is exported as well as consumed here: the ingest path
  // meters conversations without reading any limit, and metering is
  // unconditional whether or not a cap exists — `usage.ts` records counters from
  // day one whether or not anything reads them.
  exports: [PlanLimitsService, UsageCounterService],
})
export class EntitlementsModule {}
