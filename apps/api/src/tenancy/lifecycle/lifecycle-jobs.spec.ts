import {
  LIFECYCLE_NOTIFICATION_JOB_OPTIONS,
  PURGE_JOB_OPTIONS,
  lifecycleNotificationJobId,
  purgeTenantJobId,
  sweptLifecycleNotificationJobId,
} from './lifecycle-jobs';

/**
 * The rules BullMQ enforces on a custom job id, asserted against **its** rule
 * rather than against our own spelling.
 *
 * This file exists because the obvious test does not work. A spec that asserts
 * `jobId === purgeTenantJobId(id)` proves only that two pieces of our code agree
 * with each other, and that is exactly what shipped a purge id of
 * `purge:<tenantId>` with a green suite behind it: the sweeper spec asserted the
 * literal it was given, the queue was mocked, and BullMQ — the only thing that
 * has an opinion — was never in the room.
 *
 * What BullMQ actually does, in `Job.validateOptions`:
 *
 * ```js
 * if (this.opts?.jobId.includes(':') && this.opts?.jobId.split(':').length !== 3) {
 *   throw new Error('Custom Id cannot contain :');
 * }
 * if (`${parseInt(this.opts.jobId, 10)}` === this.opts?.jobId) {
 *   throw new Error('Custom Id cannot be integers');
 * }
 * ```
 *
 * And the failure is silent rather than loud: `QueueService.enqueue` catches
 * every throw and reports `failed`, so a refused id is not an exception anybody
 * sees — it is a job that is never created, on a sweep that reports zero and
 * carries on. Every hard delete in the product stopped happening that way.
 */

const TENANT_ID = '5f444444-4444-7444-8444-444444444401';
const EVENT_ID = '01a00a71-6a00-79b6-9ba2-4e5592ffc8e7';

/**
 * BullMQ's check, restated exactly. Deliberately a copy of the library's
 * predicate rather than "contains no colon": if BullMQ ever relaxes the rule,
 * this should relax with it rather than enforce a stricter one nobody asked for.
 */
function bullmqRefusesJobId(jobId: string): boolean {
  if (jobId.includes(':') && jobId.split(':').length !== 3) {
    return true;
  }

  return `${parseInt(jobId, 10)}` === jobId;
}

describe('the lifecycle queue job ids', () => {
  const ids = {
    'the purge': purgeTenantJobId(TENANT_ID),
    'a notification': lifecycleNotificationJobId(EVENT_ID),
    'a swept notification': sweptLifecycleNotificationJobId(
      EVENT_ID,
      new Date('2026-08-20T12:00:00Z'),
    ),
  };

  it.each(Object.entries(ids))('BullMQ accepts %s id', (_name, jobId) => {
    expect(bullmqRefusesJobId(jobId)).toBe(false);
  });

  it('proves the check has teeth by rejecting the id this replaced', () => {
    // The regression, named. If `bullmqRefusesJobId` ever stops catching this,
    // the assertions above are worthless and this says so.
    expect(bullmqRefusesJobId(`purge:${TENANT_ID}`)).toBe(true);
  });

  it('gives the sweep a different id from the transition path', () => {
    // The other silent failure: BullMQ ignores an `add` for an id it still
    // holds, including in the failed set. A backstop that re-queued under the
    // id a failed job is holding would be a no-op for ever, for exactly the row
    // it exists to rescue.
    expect(sweptLifecycleNotificationJobId(EVENT_ID, new Date(1))).not.toBe(
      lifecycleNotificationJobId(EVENT_ID),
    );
  });

  it('collapses one row found twice in the same sweep, and separates two sweeps', () => {
    const first = new Date('2026-08-20T12:00:00Z');
    const second = new Date('2026-08-20T12:05:00Z');

    expect(sweptLifecycleNotificationJobId(EVENT_ID, first)).toBe(
      sweptLifecycleNotificationJobId(EVENT_ID, first),
    );
    expect(sweptLifecycleNotificationJobId(EVENT_ID, first)).not.toBe(
      sweptLifecycleNotificationJobId(EVENT_ID, second),
    );
  });

  describe('the retry options', () => {
    it('retries a notification, so one mailer blip is not terminal', () => {
      // Without `attempts` BullMQ tries once. The row would keep
      // `notified_at IS NULL`, which is what the backstop reads — but the
      // backstop is the slow path, and a notice that a tenant was suspended
      // should not wait five minutes on a blip that clears in one second.
      expect(LIFECYCLE_NOTIFICATION_JOB_OPTIONS.attempts).toBeGreaterThan(1);
      expect(LIFECYCLE_NOTIFICATION_JOB_OPTIONS.backoff).toEqual({
        type: 'exponential',
        delay: 1_000,
      });
    });

    it('frees a failed purge’s id instead of retaining it', () => {
      // `removeOnFail: true` is what makes "a crashed purge is resumed by the
      // next sweep" true. Retaining the failure would hold the id, and the
      // sweep's re-queue would be ignored on every pass from then on — the
      // tenant stuck `suspended` with `purge_started_at` set, by the very
      // mechanism meant to recover it.
      expect(PURGE_JOB_OPTIONS.removeOnFail).toBe(true);
      // And no in-job retry: the sweep is the retry, and BullMQ retrying would
      // race the sweep's own recovery while holding a worker slot.
      expect(PURGE_JOB_OPTIONS.attempts).toBe(1);
    });
  });
});
