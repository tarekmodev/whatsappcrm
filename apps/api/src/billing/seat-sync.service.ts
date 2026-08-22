import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BILLING_PROVIDER, type BillingProvider } from '@whatsappcrm/contracts';
import { SEATS_CHANGED_EVENT, type SeatsChangedEvent } from '../events/domain-events';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';
import { BILLING_QUEUE, SYNC_BILLING_SEATS_JOB } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { syncBillingSeatsJobId } from './billing.constants';
import type { SyncBillingSeatsJob } from './billing-jobs';

/** A seat push is a single provider round-trip; three attempts is generous. */
const SEAT_SYNC_ATTEMPTS = 3;

/**
 * Keeps the seat count the provider bills against level with the seats the
 * tenant actually holds.
 *
 * ## Seats are a count here and identity is ours
 *
 * The provider's own seat-assignment and invitation machinery is deliberately
 * not used (billing contract, decision 1). TAR-22 already ships invitations,
 * `users.status`, `occupiesSeat`, revocation and expiry, and
 * `PlanLimitsService.assertSeatAvailable` already serialises the check on an
 * advisory lock. Adopting a second invitation system would mean two definitions
 * of "holds a seat" and an admin reconciling two invite emails. The payment rail
 * needs a number; this is the number.
 *
 * The count is `seatsUsed + seatsPending` — members who occupy a seat plus every
 * invitation still outstanding. A seat is held the moment it is offered, which
 * is the rule the enforcement path already applies, and billing a different
 * number from the one the invite check enforces is how a tenant ends up refused
 * an invite for a seat it is being charged for.
 *
 * ## Off the request path, always
 *
 * A membership change must not fail because the provider is slow, and it must
 * not wait on it either. So every push is a queued job keyed on the tenant, and
 * the *database* is the truth the retry re-reads — the job carries no count, so
 * a job that runs late pushes the current number rather than a stale one.
 *
 * ## Reductions wait for the period roll
 *
 * A tenant that removes a member mid-period keeps the paid seat until the period
 * ends. Reducing immediately would issue a credit for a seat that may be
 * re-filled next week, and the provider would prorate it. So a membership change
 * pushes **increases only**, and `BillingEventProcessor` sets `allowDecrease` on
 * the roll that follows a new period. It is a policy choice a reseller may want
 * to argue, and it is in one place so that argument is a one-line change.
 *
 * The failure direction is under-billing, never over-serving: a seat the
 * provider does not know about is a seat we do not charge for, and the nightly
 * reconciliation re-pushes it.
 */
@Injectable()
export class SeatSyncService {
  private readonly logger = new Logger(SeatSyncService.name);

  constructor(
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    private readonly queue: QueueService,
  ) {}

  /**
   * A membership change happened somewhere in the product.
   *
   * Subscribed rather than called, which is what keeps `IdentityModule` and
   * `PeopleModule` free of any knowledge that billing exists — they emit a fact
   * about seats, and whether anyone bills for it is not their concern. The
   * layering rule forbids either module importing this one, so what they share
   * is a type rather than a class, exactly as `RealtimeModule` and
   * `WebhooksModule` already do.
   */
  @OnEvent(SEATS_CHANGED_EVENT)
  async onSeatsChanged(event: SeatsChangedEvent): Promise<void> {
    await this.enqueue(event.tenantId, { allowDecrease: false });
  }

  /** Queues a push. Never throws — a queue that is down is lateness, not loss. */
  async enqueue(tenantId: string, options: { allowDecrease: boolean }): Promise<void> {
    const job: SyncBillingSeatsJob = { tenantId, allowDecrease: options.allowDecrease };

    const outcome = await this.queue.enqueue(BILLING_QUEUE, SYNC_BILLING_SEATS_JOB, job, {
      // Deterministic on the tenant, so five invitations sent in a minute queue
      // one push rather than five. The job re-reads the count, so collapsing
      // them loses nothing.
      jobId: syncBillingSeatsJobId(tenantId),
      attempts: SEAT_SYNC_ATTEMPTS,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: 100,
      removeOnFail: 1_000,
    });

    if (outcome === 'added' || outcome === 'duplicate') {
      return;
    }

    // The nightly reconciliation is the backstop, so this is lateness rather
    // than a wrong invoice — and under-billing rather than over-serving.
    this.logger.warn(
      `Seat push for tenant ${tenantId} was not enqueued (${outcome}); the nightly ` +
        'reconciliation will correct the count.',
    );
  }

  /**
   * Pushes the tenant's current seat count, honouring the reduction rule.
   *
   * Reads `users` and `invites` through `SystemPrisma`, by tenant id. There is
   * no session and no request here — a queued job runs outside both — and the
   * count has to be readable for a `past_due` tenant, which is exactly the one
   * whose seats an operator will be asked about.
   */
  async push(tenantId: string, options: { allowDecrease: boolean }): Promise<void> {
    const subscription = await this.systemPrisma.subscription.findUnique({
      where: { tenantId },
      select: { seats: true, providerSubscriptionId: true },
    });

    if (subscription === null || subscription.providerSubscriptionId === null) {
      // A trialing tenant has no provider-side subscription. Its cap is enforced
      // from `tenant_entitlements` and there is nothing to meter.
      return;
    }

    const seats = await this.currentSeatCount(tenantId);

    if (seats === subscription.seats) {
      return;
    }

    if (seats < subscription.seats && !options.allowDecrease) {
      this.logger.log(
        `Tenant ${tenantId} now holds ${seats} seats against ${subscription.seats} billed; the ` +
          'reduction is deferred to the end of the paid period.',
      );

      return;
    }

    await this.provider.updateSeats({ tenantId, seats });

    // Our count is the arbiter for seats, so the local row is updated to match
    // what was just pushed. The provider's own `subscription.updated` will
    // confirm it, and `last_event_at` makes applying it twice a no-op.
    await this.systemPrisma.subscription.update({ where: { tenantId }, data: { seats } });

    this.logger.log(`Pushed ${seats} seat(s) for tenant ${tenantId} to the billing provider.`);
  }

  /**
   * Members who occupy a seat, plus every live invitation — the same two
   * populations `PlanLimitsService.seatUsage` counts, restated here because that
   * one takes a tenant-scoped transaction and this runs with no tenant in scope.
   *
   * If the two ever disagree, the tenant is billed for a number its own invite
   * check does not enforce, so the predicates are kept identical on purpose: a
   * member is `active` or `suspended` (a suspended member keeps their seat,
   * otherwise a tenant parks staff to dodge the cap), and an invitation counts
   * while it is unaccepted, unrevoked and unexpired.
   */
  private async currentSeatCount(tenantId: string): Promise<number> {
    const members = await this.systemPrisma.user.count({
      where: { tenantId, status: { in: ['active', 'suspended'] } },
    });
    const pending = await this.systemPrisma.invite.count({
      where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    });

    return members + pending;
  }
}
