import { Inject, Injectable, Logger } from '@nestjs/common';
import { BILLING_PROVIDER, type BillingProvider } from '@whatsappcrm/contracts';
import { describeFailure } from '../common/describe-failure';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';
import { TenantLifecycleService } from '../tenancy/lifecycle/tenant-lifecycle.service';
import { SeatSyncService } from './seat-sync.service';
import { SubscriptionSyncService } from './subscription-sync.service';

/**
 * How many tenants one run reconciles.
 *
 * Bounded so a fleet that outgrows the interval degrades into taking two nights
 * rather than into one run that holds a connection for an hour. Ordered by
 * `last_event_at` oldest-first, so the subscriptions that have gone quiet — the
 * ones a missed webhook would have left stale — are always the ones reconciled
 * first.
 */
const RECONCILE_BATCH_SIZE = 200;

/** What one run did, for the log line and the tests. */
export interface ReconciliationReport {
  readonly checked: number;
  readonly corrected: number;
  readonly failed: number;
}

/**
 * The nightly comparison of our subscriptions against the provider's.
 *
 * **It exists because a missed webhook is silent.** A subscription that stopped
 * being updated looks exactly like one that has not changed, and the provider
 * disables an endpoint after ten consecutive non-2xx responses — so the failure
 * mode this corrects is one where nothing is broken enough to alert on and every
 * tenant's state is quietly a week old.
 *
 * ## Who wins on what
 *
 * **The provider wins on status and period.** It is the system of record for
 * whether a subscription is paid and which period it is in; ours is a cache of
 * that.
 *
 * **We win on seats.** The seat count is derived from `users` and `invites`,
 * which are ours, and the provider's copy is a number we pushed. So a
 * disagreement is re-pushed rather than accepted — accepting it would silently
 * lower a tenant's cap to whatever the last failed push left behind.
 *
 * ## Every correction is logged, individually
 *
 * A bug here is a wrong invoice, so the run says what it changed rather than
 * only how many. A quiet reconciliation that corrected forty tenants is not
 * reassuring; it is the thing to investigate.
 *
 * It goes through `SubscriptionSyncService` rather than writing directly, which
 * means the `last_event_at` guard applies to it too: a reconciliation that races
 * a fresh webhook loses, and that is the right way round.
 */
@Injectable()
export class BillingReconciliationService {
  private readonly logger = new Logger(BillingReconciliationService.name);

  constructor(
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    private readonly subscriptions: SubscriptionSyncService,
    private readonly seats: SeatSyncService,
    private readonly lifecycle: TenantLifecycleService,
  ) {}

  async reconcile(): Promise<ReconciliationReport> {
    const rows = await this.systemPrisma.subscription.findMany({
      // Only tenants that have actually bought something. A trialing tenant has
      // no provider-side subscription and nothing to compare against.
      where: { providerSubscriptionId: { not: null } },
      select: { tenantId: true, status: true, seats: true },
      orderBy: [{ lastEventAt: { sort: 'asc', nulls: 'first' } }],
      take: RECONCILE_BATCH_SIZE,
    });

    let corrected = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        if (await this.reconcileOne(row)) {
          corrected += 1;
        }
      } catch (error: unknown) {
        // One tenant's provider call failing must not abandon the rest of the
        // fleet — quarantine rather than abort, the same rule the migration
        // runner follows.
        failed += 1;
        this.logger.error(
          `Reconciliation failed for tenant ${row.tenantId}: ${describeFailure(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    const report = { checked: rows.length, corrected, failed };

    this.logger.log(
      `Billing reconciliation: checked ${report.checked}, corrected ${report.corrected}, ` +
        `failed ${report.failed}.`,
    );

    return report;
  }

  /** Returns true when this tenant's record was actually changed. */
  private async reconcileOne(row: {
    tenantId: string;
    status: string;
    seats: number;
  }): Promise<boolean> {
    const event = await this.provider.getSubscription({ tenantId: row.tenantId });

    if (event === null) {
      // We hold a provider subscription id the provider does not recognise —
      // a subscription deleted at the provider, or an estate mix-up between
      // sandbox and production credentials. Neither is safe to guess at, so it
      // is reported and left alone.
      this.logger.error(
        `Tenant ${row.tenantId} has a provider subscription id the provider does not return. ` +
          'This needs an operator: it is usually sandbox credentials pointed at production data ' +
          'or the reverse.',
      );

      return false;
    }

    const statusMoved = event.status !== null && event.status !== row.status;
    const outcome = await this.subscriptions.apply(event);

    if (outcome.result !== 'applied') {
      return false;
    }

    if (statusMoved) {
      this.logger.warn(
        `Tenant ${row.tenantId} was ${row.status} and the provider says ${event.status}; ` +
          'corrected. A webhook was missed.',
      );

      await this.lifecycle.applyBillingEvent(event);
    }

    // Our count is the arbiter for seats, so a disagreement is re-pushed rather
    // than accepted. `allowDecrease` because the provider's period has been
    // re-read and a deferred reduction is now due.
    if (event.seats !== null && event.seats !== row.seats) {
      this.logger.warn(
        `Tenant ${row.tenantId} is billed for ${event.seats} seat(s) and holds ${row.seats}; ` +
          're-pushing ours.',
      );

      await this.seats.enqueue(row.tenantId, { allowDecrease: true });
    }

    return statusMoved || event.seats !== row.seats;
  }
}
