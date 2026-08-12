import {
  TICKET_ENSURE_JOB,
  TICKET_QUEUE,
  type InboundMessageTicketTrigger,
  type TicketLinkResult,
  type TicketLinker,
} from '@whatsappcrm/contracts';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import type { JobHandler, JobHandlers, QueueService } from '../queue/queue.service';
import { TicketQueueRunner } from './ticket-queue.runner';

/**
 * TAR-77's consumer half: the queue handler that turns a trigger into a call on
 * TAR-75's linker.
 *
 * The linker is mocked here on purpose — what it does with a trigger is already
 * covered by `ticket-linker.service.spec.ts` against a mocked client and by
 * `ticket-linker.int-spec.ts` against a real one. What is at issue in this file
 * is the *boundary*: which payloads reach the linker at all, and what happens to
 * each of the failures 0003's error table distinguishes. Getting that wrong is
 * how a message silently stops becoming a ticket.
 */

const TENANT = '77000000-0000-7000-8000-000000000001';
const CONTACT = '77000000-0000-7000-8000-000000000002';
const CONVERSATION = '77000000-0000-7000-8000-000000000003';
const MESSAGE = '77000000-0000-7000-8000-000000000004';

const TRIGGER: InboundMessageTicketTrigger = {
  tenantId: TENANT,
  contactId: CONTACT,
  conversationId: CONVERSATION,
  messageId: MESSAGE,
  receivedAt: '2026-08-12T09:00:00.000Z',
};

const CREATED: TicketLinkResult = {
  outcome: 'created',
  ticketId: '77000000-0000-7000-8000-00000000000a',
  ticketNumber: 1,
  previousStatus: null,
  reason: null,
};

describe('TicketQueueRunner', () => {
  let ensureTicketForMessage: jest.Mock;
  let registerWorker: jest.Mock;
  let runner: TicketQueueRunner;

  /** The handler BullMQ would call, as the runner registered it. */
  function handler(): JobHandler<InboundMessageTicketTrigger> {
    const [{ handlers }] = registerWorker.mock.calls[0] as [
      { handlers: JobHandlers<InboundMessageTicketTrigger> },
    ];
    const registered = handlers[TICKET_ENSURE_JOB];

    if (registered === undefined) {
      throw new Error(`No handler registered for ${TICKET_ENSURE_JOB}`);
    }

    return registered;
  }

  /** A job as BullMQ delivers one: `data` is JSON read back out of Redis. */
  function jobOf(data: unknown): Job<InboundMessageTicketTrigger> {
    return { name: TICKET_ENSURE_JOB, data } as Job<InboundMessageTicketTrigger>;
  }

  beforeEach(() => {
    ensureTicketForMessage = jest.fn().mockResolvedValue(CREATED);
    registerWorker = jest.fn().mockReturnValue(true);

    const linker: TicketLinker = { ensureTicketForMessage };

    runner = new TicketQueueRunner({ registerWorker } as unknown as QueueService, linker);
  });

  describe('registration', () => {
    it('serves the ensure job on the queue the contract names', () => {
      runner.onApplicationBootstrap();

      expect(registerWorker).toHaveBeenCalledWith(expect.objectContaining({ queue: TICKET_QUEUE }));
      expect(handler()).toBeDefined();
    });

    /**
     * A bare clone with no Redis boots and serves HTTP. It must not also look
     * healthy: without a worker, inbound messages fill the inbox and no ticket
     * is ever opened, which is invisible until somebody opens the ticket list.
     */
    it('warns rather than throws when no worker could be started', () => {
      registerWorker.mockReturnValue(false);
      const warn = jest.spyOn(runner['logger'], 'warn').mockImplementation();

      expect(() => runner.onApplicationBootstrap()).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('No ticket worker started'));
    });
  });

  describe('a well-formed trigger', () => {
    beforeEach(() => {
      runner.onApplicationBootstrap();
    });

    it('reaches the linker exactly as the contract shapes it', async () => {
      await handler()(jobOf({ ...TRIGGER }));

      expect(ensureTicketForMessage).toHaveBeenCalledWith(TRIGGER);
    });

    /**
     * The runner opens no tenant scope of its own: `QueueService` has already
     * opened one from `job.data.tenantId`. A second place that rule lives is a
     * place it can be forgotten, and the one that forgets is the leak.
     */
    it('does not re-derive the tenant from the payload', async () => {
      await handler()(jobOf({ ...TRIGGER }));

      const [received] = ensureTicketForMessage.mock.calls[0] as [InboundMessageTicketTrigger];

      expect(received.tenantId).toBe(TENANT);
    });
  });

  describe('a payload the contract does not recognise', () => {
    beforeEach(() => {
      runner.onApplicationBootstrap();
    });

    /**
     * 0003: a malformed payload fails loudly rather than writing garbage — and
     * unrecoverably, because no number of retries changes the shape of a payload
     * that is already in Redis. Spending the whole budget first would only delay
     * the failed-set entry somebody is monitoring.
     */
    it.each([
      ['a missing field', { ...TRIGGER, messageId: undefined }],
      ['an id that is not a uuid', { ...TRIGGER, contactId: 'not-a-uuid' }],
      ['a timestamp that is not ISO-8601', { ...TRIGGER, receivedAt: 'yesterday' }],
      [
        'a tenantId of null, which the queue type allows but this job does not',
        {
          ...TRIGGER,
          tenantId: null,
        },
      ],
      ['nothing at all', undefined],
    ])('refuses %s without calling the linker', async (_case, data) => {
      await expect(handler()(jobOf(data))).rejects.toThrow(UnrecoverableError);
      expect(ensureTicketForMessage).not.toHaveBeenCalled();
    });
  });

  describe('when the linker gives up', () => {
    beforeEach(() => {
      runner.onApplicationBootstrap();
    });

    /**
     * 0003's error table: non-retryable, and *discarded* rather than failed.
     * Deactivation is a state an operator deliberately created (TAR-51), so it
     * is not a fault to alert on — and a job that failed would sit in the set
     * that is monitored for messages which never became tickets, which is a
     * different and genuinely urgent thing.
     */
    it('drops the job for a deactivated tenant instead of retrying it', async () => {
      ensureTicketForMessage.mockRejectedValue(
        new TenantNotActiveError(TENANT, 'findUnique', 'message'),
      );
      const warn = jest.spyOn(runner['logger'], 'warn').mockImplementation();

      await expect(handler()(jobOf({ ...TRIGGER }))).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(MESSAGE));
    });

    /**
     * Everything else is retryable by contract. The common case is a job that
     * overtook the transaction that wrote its message, which the next attempt
     * fixes — so it must reach BullMQ rather than be swallowed here.
     */
    it('rethrows anything else so BullMQ applies its backoff', async () => {
      ensureTicketForMessage.mockRejectedValue(new Error('message is not visible yet'));

      await expect(handler()(jobOf({ ...TRIGGER }))).rejects.toThrow('message is not visible yet');
    });

    it('rethrows retryable failures as recoverable, so the budget is actually spent', async () => {
      ensureTicketForMessage.mockRejectedValue(new Error('database unavailable'));

      await expect(handler()(jobOf({ ...TRIGGER }))).rejects.not.toBeInstanceOf(UnrecoverableError);
    });
  });
});
