import {
  ASSIGNMENT_ROUTE_JOB,
  assignmentRouteJobId,
  type TicketRoutingTrigger,
} from '@whatsappcrm/contracts';
import { Job, type Queue } from 'bullmq';

/**
 * The sibling of `ticket-ensure-job-id.spec.ts`, guarding the same landmine one
 * queue over: **BullMQ accepts the job id the routing contract publishes.**
 *
 * Worth a test rather than a comment because of *how* it would fail.
 * `QueueService.enqueue` catches everything and reports an outcome, so a
 * rejected id does not throw anywhere — it would log one warning per created
 * ticket and quietly stop routing, which is exactly how TAR-249 presented when
 * it stopped ticket *creation*. A queue whose jobs are never added looks
 * identical to a quiet afternoon.
 *
 * The control test at the bottom is what keeps the first assertion load-bearing:
 * if BullMQ ever stops rejecting a colon, the risk is gone and this file can go
 * with it.
 */
describe('the job id the routing contract publishes', () => {
  const TRIGGER: TicketRoutingTrigger = {
    tenantId: '77000000-0000-7000-8000-000000000001',
    ticketId: '77000000-0000-7000-8000-000000000002',
    contactId: '77000000-0000-7000-8000-000000000003',
    messageId: '77000000-0000-7000-8000-000000000004',
    createdAt: '2026-08-12T09:00:00.000Z',
  };

  /**
   * Enough of a queue for `Job` to construct against, and no more — a real
   * `Queue` opens a Redis connection whose reconnect timer keeps the process
   * alive, and `pnpm test` has to run with no containers up.
   */
  const queue = {
    opts: {},
    jobsOpts: {},
    qualifiedName: 'whatsappcrm-spec:assignment',
    backend: {},
    toKey: (type: string) => `whatsappcrm-spec:assignment:${type}`,
  } as unknown as Queue;

  /** `validateOptions` is protected; reaching it is the point of this file. */
  type ValidatingJob = { validateOptions(jobData: { data: string }): void };

  function validate(jobId: string): void {
    const job = new Job(queue, ASSIGNMENT_ROUTE_JOB, TRIGGER, { jobId }, jobId);

    // The same call `queue.add()` makes before it touches Redis.
    (job as unknown as ValidatingJob).validateOptions({ data: JSON.stringify(TRIGGER) });
  }

  it('is one BullMQ will accept', () => {
    expect(() => {
      validate(assignmentRouteJobId(TRIGGER));
    }).not.toThrow();
  });

  it('contains no colon, so it does not depend on the three-part exemption', () => {
    expect(assignmentRouteJobId(TRIGGER)).not.toContain(':');
  });

  it('is stable for one ticket, so a duplicate enqueue collapses', () => {
    expect(assignmentRouteJobId(TRIGGER)).toBe(assignmentRouteJobId({ ...TRIGGER }));
  });

  it('carries the tenant, so one tenant’s routing is filterable in a queue dashboard', () => {
    expect(assignmentRouteJobId(TRIGGER)).toContain(TRIGGER.tenantId);
  });

  /** Keeps the assertion above load-bearing: this is what BullMQ still rejects. */
  it('would be rejected by BullMQ if it carried a colon', () => {
    expect(() => {
      validate(`${ASSIGNMENT_ROUTE_JOB}:${TRIGGER.ticketId}`);
    }).toThrow('Custom Id cannot contain :');
  });
});
