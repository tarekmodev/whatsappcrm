import { TICKET_ENSURE_JOB, ticketEnsureJobId } from '@whatsappcrm/contracts';
import { Job, type Queue } from 'bullmq';

/**
 * One assertion, guarding one landmine: **BullMQ accepts the job id the contract
 * publishes.**
 *
 * `ticketEnsureJobId` returns `ticket-ensure-<tenant>-<message>` — colon-free by
 * construction, like every other job id in this repo. It was not always: TAR-73
 * published `ticket.ensure-for-message:<tenant>:<message>`, which BullMQ 6
 * accepted only because a colon-bearing id *that splits into exactly three
 * parts* is exempt for backwards compatibility with old repeatable jobs, an
 * exemption carrying a `TODO: replace this check in next breaking check with
 * include(':')`. TAR-249 removed the dependency rather than keep betting on it.
 *
 * What makes this worth a test rather than a comment is *how* it would fail:
 * `QueueService.enqueue` catches everything and reports an outcome, so a
 * rejected id would not throw anywhere. It would log one warning per inbound
 * message and quietly stop creating tickets.
 *
 * The control test below is what keeps the first assertion load-bearing: it
 * proves BullMQ is still the reason a colon matters. If it ever stops throwing,
 * BullMQ has loosened the rule and the risk is gone.
 */
describe('the job id the ticket contract publishes', () => {
  const TRIGGER = {
    tenantId: '77000000-0000-7000-8000-000000000001',
    contactId: '77000000-0000-7000-8000-000000000002',
    conversationId: '77000000-0000-7000-8000-000000000003',
    messageId: '77000000-0000-7000-8000-000000000004',
    receivedAt: '2026-08-12T09:00:00.000Z',
  };

  /**
   * Enough of a queue for `Job` to construct against, and no more — it reads
   * only these four members. A real `Queue` would work too, and was the first
   * attempt, but it opens a Redis connection whose reconnect timer keeps the
   * process alive: `pnpm test` has to run with no containers up, so a unit test
   * that needs one is a unit test that hangs CI.
   */
  const queue = {
    opts: {},
    jobsOpts: {},
    qualifiedName: 'whatsappcrm-spec:tickets',
    backend: {},
    toKey: (type: string) => `whatsappcrm-spec:tickets:${type}`,
  } as unknown as Queue;

  /** `validateOptions` is protected; reaching it is the point of this file. */
  type ValidatingJob = { validateOptions(jobData: { data: string }): void };

  function validate(jobId: string): void {
    const job = new Job(queue, TICKET_ENSURE_JOB, TRIGGER, { jobId }, jobId);

    // The same call `queue.add()` makes before it touches Redis.
    (job as unknown as ValidatingJob).validateOptions({ data: JSON.stringify(TRIGGER) });
  }

  it('is one BullMQ will accept', () => {
    expect(() => {
      validate(ticketEnsureJobId(TRIGGER));
    }).not.toThrow();
  });

  it('contains no colon, so it does not depend on the three-part exemption', () => {
    expect(ticketEnsureJobId(TRIGGER)).not.toContain(':');
  });

  /** Keeps the assertion above load-bearing: this is what BullMQ still rejects. */
  it('would be rejected by BullMQ if it carried a colon', () => {
    expect(() => {
      validate(`${TICKET_ENSURE_JOB}:${TRIGGER.messageId}`);
    }).toThrow('Custom Id cannot contain :');
  });
});
