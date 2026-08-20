import { Inject, Injectable, Logger } from '@nestjs/common';
import { LIFECYCLE_POLICY } from '@whatsappcrm/contracts';
import { describeFailure } from '../../common/describe-failure';
import {
  NOTIFY_TENANT_LIFECYCLE_JOB,
  PURGE_TENANT_JOB,
  TENANCY_QUEUE,
} from '../../queue/queue.constants';
import { QueueService } from '../../queue/queue.service';
import {
  LIFECYCLE_NOTIFICATION_JOB_OPTIONS,
  PURGE_JOB_OPTIONS,
  purgeTenantJobId,
  sweptLifecycleNotificationJobId,
} from './lifecycle-jobs';
import { SYSTEM_PRISMA, type SystemPrisma } from '../../prisma/prisma.tokens';
import { TenantLifecycleNotifier } from './tenant-lifecycle.notifier';
import { TenantLifecycleService } from './tenant-lifecycle.service';

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * How many due tenants one sweep acts on, per branch.
 *
 * Bounded like every other sweep in this codebase: after an outage the backlog
 * can be arbitrarily large, and a sweep that took all of it would open one
 * transaction per tenant in a burst. Oldest deadline first, capped, every
 * interval — the backlog drains across several passes, in deadline order.
 */
const SWEEP_BATCH_SIZE = 200;

/**
 * How long a `lifecycle_events` row may go unnotified before the backstop
 * re-enqueues it.
 *
 * A minute, per ADR 0009 decision 7. Long enough that a job currently in flight
 * is not raced, short enough that a Redis blip costs a tenant a minute's notice
 * rather than a sweep interval's.
 */
const NOTIFICATION_GRACE_MS = 60_000;

/** What one sweep did, for the log line and for the tests. */
export interface LifecycleSweepReport {
  readonly trialsExpired: number;
  readonly gracePeriodsElapsed: number;
  readonly purgesQueued: number;
  readonly remindersSent: number;
  readonly notificationsRequeued: number;
}

/**
 * The clock behind the tenant lifecycle (ADR 0009 decision 4).
 *
 * Six things happen on every pass, and all six are branches of the same idea: a
 * time became true and nothing was watching. Trials expire, grace periods
 * elapse, retention windows come due, two reminders fall due, and any
 * notification the queue dropped is re-enqueued.
 *
 * ## It fails safe by construction
 *
 * Every way this job can fail errs towards **keeping access and keeping data**.
 * If it is slow, a tenant stays `past_due` past its grace period. If it is down,
 * nothing is suspended and nothing is purged. There is no failure of this sweep
 * that destroys data early or locks anybody out early, and that asymmetry is why
 * it is one repeatable job rather than a set of scheduled per-tenant timers: a
 * schedule lost to a Redis flush is silent, whereas a sweep over a column
 * recovers by itself on the next pass.
 *
 * The corollary is that **the failure mode is silence**, so sweep last-success
 * age is the signal worth alerting on — 0009 names 15 minutes.
 *
 * ## Two phases, and only the first is a cross-tenant read
 *
 * Phase 1 finds due tenants: two indexed scans over `tenants` returning ids and
 * a timestamp, and one over `lifecycle_events` returning ids. No tenant data,
 * nothing reaching a caller — ADR 0009's eighth permitted `SystemPrisma` call
 * site, and its justification.
 *
 * Phase 2 acts on each tenant in its own transaction, through
 * `TenantLifecycleService.transition()`, so every write goes through the single
 * writer, produces its audit row and enqueues its notification exactly as a
 * human-triggered transition would. A tenant whose transition throws is logged
 * and skipped rather than aborting the pass — quarantine, not abort, so one bad
 * row cannot stop every other tenant's timers.
 *
 * ## The queries restate the index predicates
 *
 * `tenants_grace_due` is `(grace_period_ends_at) WHERE status IN ('past_due',
 * 'cancelled') AND grace_period_ends_at IS NOT NULL`, and `tenants_purge_due` is
 * `(purge_at) WHERE status = 'suspended' AND purge_at IS NOT NULL`. A partial
 * index is only usable when the query's `WHERE` implies the index's predicate,
 * so the clauses below are written to match rather than to read prettily. That
 * is the whole reason those two indexes were narrowed against real queries
 * rather than guessed at.
 */
@Injectable()
export class TenantLifecycleSweeper {
  private readonly logger = new Logger(TenantLifecycleSweeper.name);

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    private readonly lifecycle: TenantLifecycleService,
    private readonly notifier: TenantLifecycleNotifier,
    private readonly queue: QueueService,
  ) {}

  async sweep(now: Date = new Date()): Promise<LifecycleSweepReport> {
    const report: LifecycleSweepReport = {
      trialsExpired: await this.expireTrials(now),
      gracePeriodsElapsed: await this.elapseGracePeriods(now),
      purgesQueued: await this.queuePurges(now),
      remindersSent: (await this.remindTrialsEnding(now)) + (await this.remindDeletions(now)),
      notificationsRequeued: await this.requeueNotifications(now),
    };

    if (Object.values(report).some((count) => count > 0)) {
      // Only when it did something. A sweep that finds nothing is the normal
      // state, and a line every interval saying so is a line nobody reads.
      this.logger.log(
        `Lifecycle sweep: ${report.trialsExpired} trial(s) expired, ` +
          `${report.gracePeriodsElapsed} grace period(s) elapsed, ` +
          `${report.purgesQueued} purge(s) queued, ${report.remindersSent} reminder(s) sent, ` +
          `${report.notificationsRequeued} notification(s) re-queued.`,
      );
    }

    return report;
  }

  /**
   * `trialing → past_due`, when `trial_ends_at` has passed with no subscription.
   *
   * `past_due` rather than straight to `suspended`, and that is 0009's graph
   * rather than a softening: a trial running out starts the same fourteen-day
   * dunning window a failed card does, so a tenant that was going to pay has the
   * same time to do it.
   */
  private async expireTrials(now: Date): Promise<number> {
    const due = await this.systemPrisma.tenant.findMany({
      where: { status: 'trialing', trialEndsAt: { not: null, lte: now } },
      orderBy: { trialEndsAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
      select: { id: true, trialEndsAt: true },
    });

    return await this.transitionEach(due, 'past_due', 'trial_ends_at');
  }

  /**
   * `past_due → suspended` and `cancelled → suspended`, when the grace period
   * runs out.
   *
   * One query for both, because they are one index and one rule: a timer on
   * `tenants` elapsed and the tenant loses access. Which of the two states it
   * came from is recorded on the `lifecycle_events` row and changes nothing
   * about what happens next — both arrive at `suspended` and both start the
   * retention clock there.
   */
  private async elapseGracePeriods(now: Date): Promise<number> {
    const due = await this.systemPrisma.tenant.findMany({
      // Restates `tenants_grace_due`'s predicate exactly. See the class comment.
      where: {
        status: { in: ['past_due', 'cancelled'] },
        gracePeriodEndsAt: { not: null, lte: now },
      },
      orderBy: { gracePeriodEndsAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
      select: { id: true, gracePeriodEndsAt: true },
    });

    return await this.transitionEach(due, 'suspended', 'grace_period_ends_at');
  }

  /**
   * Queues a purge for every tenant whose retention window has elapsed, and for
   * every purge that started and did not finish.
   *
   * **Queued rather than run inline.** A purge is batched and can run for
   * minutes on a large tenant; running it here would hold this schedule's slot
   * for that whole time and delay every other tenant's timers behind it. The job
   * id is the tenant id, so a tenant already queued is not queued twice, and
   * `TenantPurgeService` re-checks that the tenant is genuinely due before its
   * first `DELETE`.
   *
   * A purge only happens through this branch, which is what "one timer, one
   * sweep branch, one code path that can destroy data" means in practice — and
   * the reason the graph has no `cancelled → deleted` edge for it to have a
   * second road.
   */
  private async queuePurges(now: Date): Promise<number> {
    const due = await this.systemPrisma.tenant.findMany({
      // Restates `tenants_purge_due`'s predicate exactly.
      where: { status: 'suspended', purgeAt: { not: null, lte: now } },
      orderBy: { purgeAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
      select: { id: true },
    });

    let queued = 0;

    for (const tenant of due) {
      const outcome = await this.queue.enqueue(
        TENANCY_QUEUE,
        PURGE_TENANT_JOB,
        { tenantId: tenant.id },
        // The id is the concurrency control — a purge already waiting or running
        // holds it, so the next sweep cannot queue a second one against the same
        // tenant. `purgeTenantJobId` also spells it with hyphens: a colon is
        // refused by BullMQ and `enqueue` reports that as `failed`, which is how
        // this silently queued nothing at all.
        { jobId: purgeTenantJobId(tenant.id), ...PURGE_JOB_OPTIONS },
      );

      if (outcome === 'added') {
        queued += 1;
      }
    }

    return queued;
  }

  /**
   * `trial_ending`, `trialEndingReminderDays` before the trial runs out.
   *
   * The stamp is claimed with a conditional `updateMany` **before** the email is
   * sent, so two replicas sweeping together produce one reminder rather than
   * two. The same order and the same trade as the notifier's `notified_at`
   * claim: a dropped reminder is a missed courtesy, and a duplicate one every
   * five minutes for three days is an incident.
   */
  private async remindTrialsEnding(now: Date): Promise<number> {
    const threshold = new Date(now.getTime() + LIFECYCLE_POLICY.trialEndingReminderDays * DAY_MS);

    const due = await this.systemPrisma.tenant.findMany({
      where: {
        status: 'trialing',
        trialEndingNotifiedAt: null,
        trialEndsAt: { not: null, lte: threshold, gt: now },
      },
      orderBy: { trialEndsAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
      select: { id: true },
    });

    return await this.remindEach(due, 'trial_ending', (tenantId) =>
      this.systemPrisma.tenant.updateMany({
        where: { id: tenantId, trialEndingNotifiedAt: null },
        data: { trialEndingNotifiedAt: new Date() },
      }),
    );
  }

  /** `deletion_reminder`, `deletionReminderDays` before the point of no return. */
  private async remindDeletions(now: Date): Promise<number> {
    const threshold = new Date(now.getTime() + LIFECYCLE_POLICY.deletionReminderDays * DAY_MS);

    const due = await this.systemPrisma.tenant.findMany({
      where: {
        status: 'suspended',
        deletionReminderNotifiedAt: null,
        purgeAt: { not: null, lte: threshold, gt: now },
      },
      orderBy: { purgeAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
      select: { id: true },
    });

    return await this.remindEach(due, 'deletion_reminder', (tenantId) =>
      this.systemPrisma.tenant.updateMany({
        where: { id: tenantId, deletionReminderNotifiedAt: null },
        data: { deletionReminderNotifiedAt: new Date() },
      }),
    );
  }

  /**
   * The notification backstop: any `lifecycle_events` row still holding
   * `notified_at IS NULL` a minute after it was written.
   *
   * This is what makes a transition committed during a Redis outage still notify
   * — the row is the truth and the queue is an accelerator (0009 decision 7). It
   * reads the partial index `lifecycle_events_notified_at_pending_idx`, which
   * holds only the backlog rather than the history, so the scan is empty in the
   * normal case.
   */
  private async requeueNotifications(now: Date): Promise<number> {
    const owing = await this.systemPrisma.lifecycleEvent.findMany({
      where: {
        notifiedAt: null,
        occurredAt: { lte: new Date(now.getTime() - NOTIFICATION_GRACE_MS) },
      },
      orderBy: { occurredAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
      select: { id: true, tenantId: true },
    });

    let requeued = 0;

    for (const event of owing) {
      const outcome = await this.queue.enqueue(
        TENANCY_QUEUE,
        NOTIFY_TENANT_LIFECYCLE_JOB,
        { tenantId: event.tenantId, eventId: event.id },
        {
          // **Not** the transition path's deterministic id. A notification that
          // exhausted its attempts leaves a failed job holding that id for as
          // long as `removeOnFail` retains it, and BullMQ ignores an `add` for
          // an id it holds — so re-queueing under it would be a silent no-op on
          // every sweep from here on, for exactly the row this backstop exists
          // to rescue. See `sweptLifecycleNotificationJobId`.
          jobId: sweptLifecycleNotificationJobId(event.id, now),
          // The extra read is worth it here and nowhere else: this count is a
          // recovery report, and a duplicate counted as a re-enqueue is the log
          // line lying about work it did not schedule.
          detectDuplicate: true,
          ...LIFECYCLE_NOTIFICATION_JOB_OPTIONS,
        },
      );

      if (outcome === 'added') {
        requeued += 1;
      }
    }

    return requeued;
  }

  /**
   * Transitions each due tenant in its own transaction, quarantining failures.
   *
   * `timer` is the trigger on every edge this class causes, which is what makes
   * "no `active → past_due` from a button" assertable from the trail rather than
   * merely intended: a row carrying `timer` was written here and nowhere else.
   * The elapsed instant goes in `metadata`, so an operator reading the trail can
   * see which clock fired without joining back to a column that has since been
   * cleared.
   */
  private async transitionEach(
    due: readonly { id: string; trialEndsAt?: Date | null; gracePeriodEndsAt?: Date | null }[],
    to: 'past_due' | 'suspended',
    timer: string,
  ): Promise<number> {
    let moved = 0;

    for (const tenant of due) {
      const elapsedAt = tenant.trialEndsAt ?? tenant.gracePeriodEndsAt;

      try {
        const result = await this.lifecycle.transition({
          tenantId: tenant.id,
          to,
          trigger: 'timer',
          actor: { actorType: 'system', actorUserId: null, actorLabel: null },
          metadata: {
            timer,
            ...(elapsedAt === null || elapsedAt === undefined
              ? {}
              : { elapsedAt: elapsedAt.toISOString() }),
          },
        });

        if (result.transitioned) {
          moved += 1;
        }
      } catch (error: unknown) {
        // Quarantine rather than abort: one tenant in an unexpected state must
        // not stop every other tenant's timer from firing.
        this.logger.error(
          `Could not move tenant ${tenant.id} to ${to} on ${timer}: ${describeFailure(error)}`,
        );
      }
    }

    return moved;
  }

  private async remindEach(
    due: readonly { id: string }[],
    template: 'trial_ending' | 'deletion_reminder',
    claim: (tenantId: string) => Promise<{ count: number }>,
  ): Promise<number> {
    let sent = 0;

    for (const tenant of due) {
      try {
        const { count } = await claim(tenant.id);

        if (count === 0) {
          // Another replica got there first.
          continue;
        }

        await this.notifier.remind(tenant.id, template);
        sent += 1;
      } catch (error: unknown) {
        this.logger.error(
          `Could not send the ${template} notice for tenant ${tenant.id}: ${describeFailure(error)}`,
        );
      }
    }

    return sent;
  }
}
