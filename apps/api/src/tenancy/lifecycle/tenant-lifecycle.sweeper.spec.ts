import { LIFECYCLE_POLICY } from '@whatsappcrm/contracts';
import type { SystemPrisma } from '../../prisma/prisma.tokens';
import {
  NOTIFY_TENANT_LIFECYCLE_JOB,
  PURGE_TENANT_JOB,
  TENANCY_QUEUE,
} from '../../queue/queue.constants';
import type { QueueService } from '../../queue/queue.service';
import { purgeTenantJobId, sweptLifecycleNotificationJobId } from './lifecycle-jobs';
import type { TenantLifecycleNotifier } from './tenant-lifecycle.notifier';
import type { TenantLifecycleService } from './tenant-lifecycle.service';
import { TenantLifecycleSweeper } from './tenant-lifecycle.sweeper';

/**
 * The clock behind the lifecycle: which rows each branch selects, what it does
 * with them, and what it refuses to do twice.
 *
 * The database is stubbed, so what is asserted is the **predicates** and the
 * ordering — that a branch asks for rows the partial index it depends on can
 * serve, that it claims a reminder before sending it, and that one tenant
 * failing does not stop the rest. Whether those predicates return the right rows
 * against a real schema is `lifecycle-sweep.int-spec.ts`'s job.
 */

const NOW = new Date('2026-08-16T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

const TENANT_ONE = '5c111111-1111-7111-8111-111111111101';
const TENANT_TWO = '5c111111-1111-7111-8111-111111111102';

describe('TenantLifecycleSweeper', () => {
  let findManyTenants: jest.Mock;
  let updateManyTenants: jest.Mock;
  let findManyEvents: jest.Mock;
  let transition: jest.Mock;
  let remind: jest.Mock;
  let enqueue: jest.Mock;
  let sweeper: TenantLifecycleSweeper;

  beforeEach(() => {
    findManyTenants = jest.fn().mockResolvedValue([]);
    updateManyTenants = jest.fn().mockResolvedValue({ count: 1 });
    findManyEvents = jest.fn().mockResolvedValue([]);
    transition = jest.fn().mockResolvedValue({ transitioned: true, eventId: 'event' });
    remind = jest.fn().mockResolvedValue(undefined);
    enqueue = jest.fn().mockResolvedValue('added');

    const systemPrisma = {
      tenant: { findMany: findManyTenants, updateMany: updateManyTenants },
      lifecycleEvent: { findMany: findManyEvents },
    } as unknown as SystemPrisma;

    sweeper = new TenantLifecycleSweeper(
      systemPrisma,
      { transition } as unknown as TenantLifecycleService,
      { remind } as unknown as TenantLifecycleNotifier,
      { enqueue } as unknown as QueueService,
    );
  });

  /** The `where` of the nth `tenant.findMany`, in branch order. */
  function whereOfCall(index: number): Record<string, unknown> {
    const [{ where }] = findManyTenants.mock.calls[index] as [{ where: Record<string, unknown> }];

    return where;
  }

  describe('expiring trials', () => {
    it('moves a trial that ran out to `past_due`, on a timer', async () => {
      findManyTenants.mockResolvedValueOnce([
        { id: TENANT_ONE, trialEndsAt: new Date(NOW.getTime() - DAY_MS) },
      ]);

      const report = await sweeper.sweep(NOW);

      expect(report.trialsExpired).toBe(1);
      expect(transition).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ONE,
          to: 'past_due',
          // `past_due` and not straight to `suspended`: a trial running out
          // starts the same dunning window a failed card does.
          trigger: 'timer',
          actor: { actorType: 'system', actorUserId: null, actorLabel: null },
        }),
      );
    });

    it('records which clock fired, so the trail is readable after the column is cleared', async () => {
      const elapsed = new Date(NOW.getTime() - DAY_MS);
      findManyTenants.mockResolvedValueOnce([{ id: TENANT_ONE, trialEndsAt: elapsed }]);

      await sweeper.sweep(NOW);

      const [{ metadata }] = transition.mock.calls[0] as [{ metadata: Record<string, string> }];

      expect(metadata).toEqual({ timer: 'trial_ends_at', elapsedAt: elapsed.toISOString() });
    });

    it('only looks at trials that have actually elapsed', async () => {
      await sweeper.sweep(NOW);

      expect(whereOfCall(0)).toEqual({
        status: 'trialing',
        trialEndsAt: { not: null, lte: NOW },
      });
    });
  });

  describe('elapsing grace periods', () => {
    it('restates the partial index’s predicate, so the scan can use it', async () => {
      await sweeper.sweep(NOW);

      // `tenants_grace_due` is predicated on `status IN ('past_due','cancelled')
      // AND grace_period_ends_at IS NOT NULL`. A query whose `WHERE` does not
      // imply that predicate cannot use the index, and the sweep silently
      // becomes a sequential scan over every tenant.
      expect(whereOfCall(1)).toEqual({
        status: { in: ['past_due', 'cancelled'] },
        gracePeriodEndsAt: { not: null, lte: NOW },
      });
    });

    it('suspends both a lapsed dunning window and a lapsed cancellation', async () => {
      findManyTenants.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { id: TENANT_ONE, gracePeriodEndsAt: NOW },
        { id: TENANT_TWO, gracePeriodEndsAt: NOW },
      ]);

      const report = await sweeper.sweep(NOW);

      expect(report.gracePeriodsElapsed).toBe(2);
      expect(transition).toHaveBeenCalledTimes(2);
      expect(transition).toHaveBeenLastCalledWith(
        expect.objectContaining({ tenantId: TENANT_TWO, to: 'suspended', trigger: 'timer' }),
      );
    });

    it('quarantines one tenant’s failure rather than aborting the pass', async () => {
      findManyTenants.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { id: TENANT_ONE, gracePeriodEndsAt: NOW },
        { id: TENANT_TWO, gracePeriodEndsAt: NOW },
      ]);
      transition.mockRejectedValueOnce(new Error('deadlock'));

      const report = await sweeper.sweep(NOW);

      // One tenant in an unexpected state must not stop every other tenant's
      // timer from firing.
      expect(report.gracePeriodsElapsed).toBe(1);
      expect(transition).toHaveBeenCalledTimes(2);
    });
  });

  describe('queuing purges', () => {
    it('restates `tenants_purge_due`’s predicate', async () => {
      await sweeper.sweep(NOW);

      expect(whereOfCall(2)).toEqual({
        status: 'suspended',
        purgeAt: { not: null, lte: NOW },
      });
    });

    it('queues rather than purging inline, keyed so a tenant is not queued twice', async () => {
      findManyTenants
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: TENANT_ONE }]);

      const report = await sweeper.sweep(NOW);

      expect(report.purgesQueued).toBe(1);
      expect(enqueue).toHaveBeenCalledWith(
        TENANCY_QUEUE,
        PURGE_TENANT_JOB,
        { tenantId: TENANT_ONE },
        expect.objectContaining({ jobId: purgeTenantJobId(TENANT_ONE) }) as unknown,
      );
      // A purge can run for minutes on a large tenant. Running it here would
      // hold the schedule's slot and delay every other tenant's timers.
      expect(transition).not.toHaveBeenCalled();
    });
  });

  describe('the two reminders', () => {
    it('warns a trial three days out, and claims the stamp before sending', async () => {
      findManyTenants
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: TENANT_ONE }]);

      await sweeper.sweep(NOW);

      expect(whereOfCall(3)).toEqual({
        status: 'trialing',
        trialEndingNotifiedAt: null,
        trialEndsAt: {
          not: null,
          lte: new Date(NOW.getTime() + LIFECYCLE_POLICY.trialEndingReminderDays * DAY_MS),
          // Strictly in the future: a trial that has already run out is the
          // expiry branch's, and reminding somebody about a trial that ended
          // yesterday is worse than saying nothing.
          gt: NOW,
        },
      });
      expect(updateManyTenants).toHaveBeenCalledWith({
        where: { id: TENANT_ONE, trialEndingNotifiedAt: null },
        data: { trialEndingNotifiedAt: expect.any(Date) as Date },
      });
      expect(remind).toHaveBeenCalledWith(TENANT_ONE, 'trial_ending');
    });

    it('sends nothing when another replica claimed the stamp first', async () => {
      findManyTenants
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: TENANT_ONE }]);
      updateManyTenants.mockResolvedValue({ count: 0 });

      const report = await sweeper.sweep(NOW);

      // The claim is the concurrency control. Without it the sweep runs every
      // five minutes over a window measured in days, and a tenant is emailed
      // hundreds of times.
      expect(remind).not.toHaveBeenCalled();
      expect(report.remindersSent).toBe(0);
    });

    it('warns before a purge, seven days out', async () => {
      findManyTenants
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: TENANT_TWO }]);

      await sweeper.sweep(NOW);

      expect(whereOfCall(4)).toEqual({
        status: 'suspended',
        deletionReminderNotifiedAt: null,
        purgeAt: {
          not: null,
          lte: new Date(NOW.getTime() + LIFECYCLE_POLICY.deletionReminderDays * DAY_MS),
          gt: NOW,
        },
      });
      expect(remind).toHaveBeenCalledWith(TENANT_TWO, 'deletion_reminder');
    });
  });

  describe('the notification backstop', () => {
    it('re-enqueues a transition committed while the queue was down', async () => {
      findManyEvents.mockResolvedValue([{ id: 'event-1', tenantId: TENANT_ONE }]);

      const report = await sweeper.sweep(NOW);

      expect(report.notificationsRequeued).toBe(1);
      expect(enqueue).toHaveBeenCalledWith(
        TENANCY_QUEUE,
        NOTIFY_TENANT_LIFECYCLE_JOB,
        { tenantId: TENANT_ONE, eventId: 'event-1' },
        expect.objectContaining({
          // **Not** the transition path's id. That one may still be held by a
          // failed job `removeOnFail` retains, and BullMQ ignores an `add` for an
          // id it holds — so reusing it would make this backstop a permanent
          // no-op for exactly the row it exists to rescue.
          jobId: sweptLifecycleNotificationJobId('event-1', NOW),
          detectDuplicate: true,
          attempts: 3,
        }) as unknown,
      );
    });

    it('leaves a row alone for a minute, so a job in flight is not raced', async () => {
      await sweeper.sweep(NOW);

      const [{ where }] = findManyEvents.mock.calls[0] as [
        { where: { notifiedAt: null; occurredAt: { lte: Date } } },
      ];

      expect(where.notifiedAt).toBeNull();
      expect(where.occurredAt.lte).toEqual(new Date(NOW.getTime() - 60_000));
    });
  });

  it('does nothing, loudly or otherwise, when nothing is due', async () => {
    const report = await sweeper.sweep(NOW);

    expect(report).toEqual({
      trialsExpired: 0,
      gracePeriodsElapsed: 0,
      purgesQueued: 0,
      remindersSent: 0,
      notificationsRequeued: 0,
    });
    expect(transition).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
