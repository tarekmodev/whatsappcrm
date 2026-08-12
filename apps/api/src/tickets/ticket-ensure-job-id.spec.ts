import { TICKET_ENSURE_JOB, ticketEnsureJobId } from '@whatsappcrm/contracts';
import { Job, type Queue } from 'bullmq';

/**
 * One assertion, guarding one landmine: **BullMQ accepts the job id the contract
 * publishes.**
 *
 * `ticketEnsureJobId` (TAR-73) returns `ticket.ensure-for-message:<tenant>:<message>`.
 * Every other job id in this repo is hyphenated, and `media-jobs.ts` says why in
 * as many words: "BullMQ reserves `:` for its own Redis key structure and
 * rejects a custom job id containing one". That is very nearly true — the actual
 * check in BullMQ 6 rejects a colon-bearing id *unless it splits into exactly
 * three parts*, an exemption kept only for backwards compatibility with old
 * repeatable jobs, and carrying a `TODO: replace this check in next breaking
 * check with include(':')`.
 *
 * So the contract's id is legal today by landing exactly on that exemption, and
 * is scheduled to stop being legal. What makes this worth a test rather than a
 * comment is *how* it would fail: `QueueService.enqueue` catches everything and
 * reports an outcome, so the id being rejected would not throw anywhere. It
 * would log one warning per inbound message and quietly stop creating tickets.
 *
 * This test fails at the moment a BullMQ upgrade tightens the rule, which is
 * where that change is cheap to handle. The fix is not to patch it here: the id
 * is TAR-73's to change, and 0003's own instruction is that a contract mismatch
 * goes back through the architect rather than being worked around at the call
 * site.
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

  /**
   * Pins *why* the id above passes. If this stops rejecting, BullMQ has loosened
   * the rule and the risk is gone; if the test above starts failing while this
   * one still passes, BullMQ has tightened it as promised.
   */
  it('passes only because of the three-part exemption, not because colons are allowed', () => {
    expect(() => {
      validate(`${TICKET_ENSURE_JOB}:${TRIGGER.messageId}`);
    }).toThrow('Custom Id cannot contain :');
  });
});
