import type { ConfigService } from '@nestjs/config';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { WEBHOOK_FAILURE_REASON } from './webhook-failure-reasons';
import type { WebhookEventsRepository } from './webhook-events.repository';
import type { WhatsAppAccountResolver } from './whatsapp-account.resolver';
import { WhatsAppEventProcessor } from './whatsapp-event.processor';
import type { WhatsAppInboundWriter } from './whatsapp-inbound.writer';

const MAX_ATTEMPTS = 3;
const PHONE_NUMBER_ID = '1234567890';
const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const ACCOUNT_A = '00000000-0000-4000-8000-0000000000aa';

/**
 * One change, shaped the way Meta shapes it for that `field`.
 *
 * `metadata` is attached **only** to a `messages` change, because that is the
 * only change that carries one. A helper that injected it everywhere would test
 * a payload Meta never sends, and would have hidden the batch-wide parse failure
 * a template-status change used to cause.
 */
function change(field: string, value: Record<string, unknown>): unknown {
  return {
    field,
    value:
      field === 'messages' ? { metadata: { phone_number_id: PHONE_NUMBER_ID }, ...value } : value,
  };
}

function notification(value: Record<string, unknown>, field = 'messages'): unknown {
  return batch(change(field, value));
}

/** Several changes in one delivery, which is how Meta actually batches them. */
function batch(...changes: unknown[]): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba-1', changes }],
  };
}

/**
 * A template-status change as Meta sends it: no `metadata`, no routing key, and
 * nothing this pipeline reads.
 */
const TEMPLATE_STATUS_CHANGE = change('message_template_status_update', {
  event: 'APPROVED',
  message_template_id: 1234567890,
  message_template_name: 'order_update',
  message_template_language: 'en_US',
});

const INBOUND_TEXT = {
  messages: [
    {
      id: 'wamid.1',
      from: '966501234567',
      timestamp: '1786190400',
      type: 'text',
      text: { body: 'hello' },
    },
  ],
};

describe('WhatsAppEventProcessor', () => {
  let events: {
    claim: jest.Mock;
    markProcessed: jest.Mock;
    markFailed: jest.Mock;
    recordAttemptFailure: jest.Mock;
  };
  let resolve: jest.Mock;
  let writer: { applyInboundMessage: jest.Mock; applyStatusUpdate: jest.Mock };
  let processor: WhatsAppEventProcessor;

  beforeEach(() => {
    events = {
      claim: jest
        .fn()
        .mockResolvedValue({ id: 'event-1', payload: notification(INBOUND_TEXT), attempts: 1 }),
      markProcessed: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      recordAttemptFailure: jest.fn().mockResolvedValue(undefined),
    };
    resolve = jest.fn().mockResolvedValue({ tenantId: TENANT_A, whatsappAccountId: ACCOUNT_A });
    writer = {
      applyInboundMessage: jest.fn().mockResolvedValue(true),
      applyStatusUpdate: jest.fn().mockResolvedValue(true),
    };

    processor = new WhatsAppEventProcessor(
      { getOrThrow: () => MAX_ATTEMPTS } as unknown as ConfigService,
      events as unknown as WebhookEventsRepository,
      { resolve } as unknown as WhatsAppAccountResolver,
      writer as unknown as WhatsAppInboundWriter,
      new TenantContextService(),
    );
  });

  describe('claiming', () => {
    it('applies the payload and records the tenant it resolved to', async () => {
      await processor.process('event-1');

      expect(writer.applyInboundMessage).toHaveBeenCalledWith(
        { tenantId: TENANT_A, whatsappAccountId: ACCOUNT_A },
        expect.objectContaining({ id: 'wamid.1', from: '966501234567' }),
        { displayName: null },
      );
      expect(events.markProcessed).toHaveBeenCalledWith('event-1', TENANT_A);
    });

    /**
     * A Meta retry, a sweeper re-enqueue and an expired job lock all land here.
     * The claim is what makes each of them a no-op UPDATE rather than a
     * duplicated message.
     */
    it('does nothing when the event is no longer claimable', async () => {
      events.claim.mockResolvedValue(null);

      await processor.process('event-1');

      expect(writer.applyInboundMessage).not.toHaveBeenCalled();
      expect(events.markProcessed).not.toHaveBeenCalled();
    });
  });

  describe('tenant routing', () => {
    it('runs every write inside the resolved tenant’s scope', async () => {
      const tenantContext = new TenantContextService();
      const seen: (string | null)[] = [];

      writer.applyInboundMessage.mockImplementation(() => {
        seen.push(tenantContext.tenantId);
        return Promise.resolve(true);
      });

      const scoped = new WhatsAppEventProcessor(
        { getOrThrow: () => MAX_ATTEMPTS } as unknown as ConfigService,
        events as unknown as WebhookEventsRepository,
        { resolve } as unknown as WhatsAppAccountResolver,
        writer as unknown as WhatsAppInboundWriter,
        tenantContext,
      );

      await scoped.process('event-1');

      expect(seen).toEqual([TENANT_A]);
      // The scope is closed again afterwards: a worker must not leak one job's
      // tenant into the next.
      expect(tenantContext.tenantId).toBeNull();
    });

    /**
     * A number connected before its tenant record existed. Parked with a
     * distinct reason and the payload intact, never dropped — TAR-39, failure
     * modes.
     */
    it('parks an unknown phone_number_id with a distinct reason, keeping the payload', async () => {
      resolve.mockResolvedValue(null);

      await processor.process('event-1');

      expect(events.markFailed).toHaveBeenCalledWith(
        'event-1',
        expect.stringContaining(WEBHOOK_FAILURE_REASON.unknownPhoneNumber),
        null,
      );
      expect(events.markProcessed).not.toHaveBeenCalled();
      expect(writer.applyInboundMessage).not.toHaveBeenCalled();
    });

    it('parks a deactivated tenant rather than burning the retry budget', async () => {
      writer.applyInboundMessage.mockRejectedValue(
        new TenantNotActiveError(TENANT_A, 'create', 'Message'),
      );

      await processor.process('event-1');

      expect(events.markFailed).toHaveBeenCalledWith(
        'event-1',
        expect.stringContaining(WEBHOOK_FAILURE_REASON.tenantNotActive),
        TENANT_A,
      );
    });

    it('parks a wa_id that is not a phone number', async () => {
      writer.applyInboundMessage.mockResolvedValue(false);

      await processor.process('event-1');

      expect(events.markFailed).toHaveBeenCalledWith(
        'event-1',
        expect.stringContaining(WEBHOOK_FAILURE_REASON.unroutableContact),
        TENANT_A,
      );
    });
  });

  describe('payloads it does not act on', () => {
    it('parks a signed payload it cannot parse instead of retrying it', async () => {
      events.claim.mockResolvedValue({
        id: 'event-1',
        payload: { entry: 'not an array' },
        attempts: 1,
      });

      await processor.process('event-1');

      expect(events.markFailed).toHaveBeenCalledWith(
        'event-1',
        expect.stringContaining(WEBHOOK_FAILURE_REASON.unrecognisedPayload),
      );
    });

    /** Meta delivers template and account updates to the same URL. */
    it('processes a non-messages field as a successful no-op', async () => {
      events.claim.mockResolvedValue({
        id: 'event-1',
        payload: batch(TEMPLATE_STATUS_CHANGE),
        attempts: 1,
      });

      await processor.process('event-1');

      expect(resolve).not.toHaveBeenCalled();
      expect(events.markProcessed).toHaveBeenCalledWith('event-1', null);
    });

    it('writes the message in a batch that also carries a template-status change', async () => {
      // Meta batches several changes into one delivery, and only a `messages`
      // change carries `metadata`. Validating every change against the messages
      // shape fails the whole parse, and the customer's message — signed,
      // stored, perfectly readable — is parked as unrecognisable.
      events.claim.mockResolvedValue({
        id: 'event-1',
        payload: batch(TEMPLATE_STATUS_CHANGE, change('messages', INBOUND_TEXT)),
        attempts: 1,
      });

      await processor.process('event-1');

      expect(writer.applyInboundMessage).toHaveBeenCalledTimes(1);
      expect(events.markFailed).not.toHaveBeenCalled();
      expect(events.markProcessed).toHaveBeenCalledWith('event-1', TENANT_A);
    });

    it('parks an unreadable messages change without losing the rest of the batch', async () => {
      // The strict schema still applies where it is read: a `messages` change
      // with no routing key cannot be applied, but the change beside it can.
      events.claim.mockResolvedValue({
        id: 'event-1',
        payload: batch(
          { field: 'messages', value: { messages: [] } },
          change('messages', INBOUND_TEXT),
        ),
        attempts: 1,
      });

      await processor.process('event-1');

      expect(writer.applyInboundMessage).toHaveBeenCalledTimes(1);
      expect(events.markFailed).toHaveBeenCalledWith(
        'event-1',
        expect.stringContaining(WEBHOOK_FAILURE_REASON.unrecognisedPayload),
        TENANT_A,
      );
    });
  });

  describe('status webhooks', () => {
    it('applies each status update in the batch', async () => {
      events.claim.mockResolvedValue({
        id: 'event-1',
        payload: notification({
          statuses: [
            {
              id: 'wamid.1',
              status: 'read',
              timestamp: '1786190400',
              recipient_id: '966501234567',
            },
          ],
        }),
        attempts: 1,
      });

      await processor.process('event-1');

      expect(writer.applyStatusUpdate).toHaveBeenCalledWith(
        { tenantId: TENANT_A, whatsappAccountId: ACCOUNT_A },
        expect.objectContaining({ id: 'wamid.1', status: 'read' }),
      );
      expect(events.markProcessed).toHaveBeenCalledWith('event-1', TENANT_A);
    });
  });

  describe('transient failure', () => {
    it('rethrows so BullMQ retries, and records the reason on the row', async () => {
      writer.applyInboundMessage.mockRejectedValue(new Error('connection reset'));

      await expect(processor.process('event-1')).rejects.toThrow('connection reset');

      expect(events.recordAttemptFailure).toHaveBeenCalledWith('event-1', 'connection reset');
      expect(events.markFailed).not.toHaveBeenCalled();
    });

    /**
     * The counter lives on the row rather than on the job, so a sweeper
     * re-enqueue after a Redis outage cannot silently reset the budget.
     */
    it('parks the event once the retry budget on the row is spent', async () => {
      events.claim.mockResolvedValue({
        id: 'event-1',
        payload: notification(INBOUND_TEXT),
        attempts: MAX_ATTEMPTS,
      });
      writer.applyInboundMessage.mockRejectedValue(new Error('connection reset'));

      await processor.process('event-1');

      expect(events.markFailed).toHaveBeenCalledWith(
        'event-1',
        expect.stringContaining(WEBHOOK_FAILURE_REASON.attemptsExhausted),
      );
    });
  });

  describe('the contact profile Meta attaches', () => {
    it('passes the profile name through for the wa_id it belongs to', async () => {
      events.claim.mockResolvedValue({
        id: 'event-1',
        payload: notification({
          ...INBOUND_TEXT,
          contacts: [{ wa_id: '966501234567', profile: { name: 'Layla' } }],
        }),
        attempts: 1,
      });

      await processor.process('event-1');

      expect(writer.applyInboundMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        {
          displayName: 'Layla',
        },
      );
    });
  });
});
