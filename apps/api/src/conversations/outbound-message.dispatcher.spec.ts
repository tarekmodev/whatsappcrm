import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { MediaSendResolver } from '../media/media-send.resolver';
import { MESSAGE_STATUS_CHANGED_EVENT } from '../events/domain-events';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import {
  MetaAuthenticationError,
  MetaRateLimitedError,
  MetaRequestRejectedError,
  MetaUnavailableError,
} from '../whatsapp/meta-cloud-api.errors';
import type { WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service';
import { SEND_MAX_ATTEMPTS } from './conversations.constants';
import { OutboundMessageDispatcher } from './outbound-message.dispatcher';
import type { SendOutboundMessageJob } from './outbound-message.jobs';

/**
 * What makes a redelivery safe, and which failures are worth another attempt.
 *
 * The load-bearing assertion is the first one: a message that is no longer
 * `queued` is left alone. That guard is what turns a worker which crashed after
 * Meta accepted the send into lateness rather than a second message to the
 * customer.
 */

const TENANT = '68444444-4444-7444-8444-444444444401';
const MESSAGE = '68444444-4444-7444-8444-4444444444e0';
const JOB: SendOutboundMessageJob = { tenantId: TENANT, messageId: MESSAGE };

function metaDetail() {
  return { code: 131047, subcode: null, message: 'Re-engagement message', traceId: 'trace-1' };
}

/** The `data` of the first guarded update, typed so the assertions are not `any` walks. */
function writtenBy(updateMany: jest.Mock): Record<string, unknown> {
  const call = updateMany.mock.calls[0] as [{ data: Record<string, unknown> }] | undefined;

  if (call === undefined) {
    throw new Error('no update was written');
  }

  return call[0].data;
}

describe('OutboundMessageDispatcher', () => {
  let findUnique: jest.Mock;
  let updateMany: jest.Mock;
  let findFirstTenant: jest.Mock;
  let sendText: jest.Mock;
  let sendMedia: jest.Mock;
  let sendTemplate: jest.Mock;
  let resolveForSend: jest.Mock;
  let emit: jest.Mock;
  let dispatcher: OutboundMessageDispatcher;

  function queuedMessage(overrides: Record<string, unknown> = {}) {
    return {
      id: MESSAGE,
      tenantId: TENANT,
      conversationId: '68444444-4444-7444-8444-4444444444c1',
      status: 'queued',
      body: 'On its way.',
      conversation: {
        whatsappAccountId: '68444444-4444-7444-8444-4444444444a0',
        contact: { phoneE164: '+966500000001' },
      },
      attachments: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    findUnique = jest.fn(() => Promise.resolve(queuedMessage()));
    updateMany = jest.fn(() => Promise.resolve({ count: 1 }));
    sendText = jest.fn(() => Promise.resolve({ providerMessageId: 'wamid.1' }));
    sendMedia = jest.fn(() => Promise.resolve({ providerMessageId: 'wamid.2' }));
    sendTemplate = jest.fn(() => Promise.resolve({ providerMessageId: 'wamid.3' }));
    resolveForSend = jest.fn(() => Promise.resolve({ mediaId: 'meta-handle' }));
    emit = jest.fn();

    findFirstTenant = jest.fn(() => Promise.resolve({ status: 'active' }));

    dispatcher = new OutboundMessageDispatcher(
      {
        message: { findUnique, updateMany },
        tenant: { findFirst: findFirstTenant },
      } as unknown as TenantPrisma,
      { sendText, sendMedia, sendTemplate } as unknown as WhatsAppSenderService,
      { resolveForSend } as unknown as MediaSendResolver,
      { emit } as unknown as EventEmitter2,
    );
  });

  it('sends the text on the row and records Meta id', async () => {
    await dispatcher.deliver(JOB, 1);

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+966500000001', body: 'On its way.' }),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: MESSAGE, status: 'queued' },
      data: { status: 'sent', providerMessageId: 'wamid.1' },
    });
    expect(emit).toHaveBeenCalledWith(
      MESSAGE_STATUS_CHANGED_EVENT,
      expect.objectContaining({ status: 'sent', providerMessageId: 'wamid.1' }),
    );
  });

  it('does nothing for a message that is no longer queued', async () => {
    // The redelivery guard. Without it, a worker that crashed after Meta
    // accepted the send would send the customer a second message.
    findUnique.mockResolvedValueOnce(queuedMessage({ status: 'sent' }));

    await dispatcher.deliver(JOB, 1);

    expect(sendText).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does nothing when the row has gone', async () => {
    findUnique.mockResolvedValueOnce(null);

    await expect(dispatcher.deliver(JOB, 1)).resolves.toBeUndefined();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('uploads and sends an attachment, with the body as the caption', async () => {
    findUnique.mockResolvedValueOnce(
      queuedMessage({
        body: 'The receipt',
        attachments: [
          {
            mediaObjectId: '68444444-4444-7444-8444-4444444444f1',
            kind: 'image',
            filename: 'r.png',
          },
        ],
      }),
    );

    await dispatcher.deliver(JOB, 1);

    expect(resolveForSend).toHaveBeenCalledWith(
      '68444444-4444-7444-8444-4444444444f1',
      '68444444-4444-7444-8444-4444444444a0',
    );
    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', caption: 'The receipt', fileName: 'r.png' }),
    );
  });

  it('sends a template from the inputs the job carried', async () => {
    await dispatcher.deliver(
      { ...JOB, template: { name: 'order_shipped', languageCode: 'en_US', variables: ['Maria'] } },
      1,
    );

    expect(sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'order_shipped', variables: ['Maria'] }),
    );
  });

  it('resolves a media header into a handle Meta holds', async () => {
    await dispatcher.deliver(
      {
        ...JOB,
        template: {
          name: 'order_shipped',
          languageCode: 'en_US',
          variables: [],
          header: { format: 'image', mediaId: '68444444-4444-7444-8444-4444444444f1' },
        },
      },
      1,
    );

    expect(sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ header: { format: 'image', media: { mediaId: 'meta-handle' } } }),
    );
  });

  describe('when Meta refuses', () => {
    it('rethrows a transient failure so the queue retries it', async () => {
      sendText.mockRejectedValueOnce(new MetaUnavailableError(503, null, 'timeout'));

      await expect(dispatcher.deliver(JOB, 1)).rejects.toBeInstanceOf(MetaUnavailableError);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('rethrows a throttle so the queue backs off', async () => {
      sendText.mockRejectedValueOnce(new MetaRateLimitedError(429, null, 30));

      await expect(dispatcher.deliver(JOB, 1)).rejects.toBeInstanceOf(MetaRateLimitedError);
    });

    it('fails the message once the attempts are spent', async () => {
      sendText.mockRejectedValueOnce(new MetaUnavailableError(503, null, 'timeout'));

      await expect(dispatcher.deliver(JOB, SEND_MAX_ATTEMPTS)).resolves.toBeUndefined();
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: MESSAGE, status: 'queued' } }),
      );
      expect(writtenBy(updateMany)).toMatchObject({ status: 'failed' });
    });

    it('does not retry a rejected request, and records Meta own code', async () => {
      // Repeating it would fail identically and burn rate limit.
      sendText.mockRejectedValueOnce(new MetaRequestRejectedError(400, metaDetail()));

      await expect(dispatcher.deliver(JOB, 1)).resolves.toBeUndefined();
      expect(writtenBy(updateMany)).toMatchObject({
        status: 'failed',
        errorCode: '131047',
      });
    });

    it('does not retry a rejected credential', async () => {
      // Retrying one is what gets an app flagged; the tenant has to re-connect.
      sendText.mockRejectedValueOnce(new MetaAuthenticationError(401, null));

      await expect(dispatcher.deliver(JOB, 1)).resolves.toBeUndefined();
      expect(writtenBy(updateMany)).toMatchObject({ status: 'failed' });
    });

    it('publishes the failure, with no provider id to publish', async () => {
      sendText.mockRejectedValueOnce(new MetaRequestRejectedError(400, metaDetail()));

      await dispatcher.deliver(JOB, 1);

      expect(emit).toHaveBeenCalledWith(
        MESSAGE_STATUS_CHANGED_EVENT,
        expect.objectContaining({ status: 'failed', providerMessageId: null }),
      );
    });

    it('emits nothing when the status had already moved on', async () => {
      // A `delivered` webhook can legitimately land before this write. The
      // guarded update matches nothing, and no event claims otherwise.
      sendText.mockRejectedValueOnce(new MetaRequestRejectedError(400, metaDetail()));
      updateMany.mockResolvedValueOnce({ count: 0 });

      await dispatcher.deliver(JOB, 1);

      expect(emit).not.toHaveBeenCalled();
    });
  });

  /**
   * TAR-538 / ADR 0009 decision 2, and the regression that made it necessary.
   *
   * `TENANT_STATUS_EFFECTS.suspended.outboundAllowed` has been `false` since the
   * contract was published, and until the lifecycle engine landed it was enforced
   * by accident: `assert_tenant_active` refused every status but `active`, so a
   * suspended tenant's queued send died at the data layer.
   *
   * Widening that gate to `assert_tenant_serviceable` — required, so inbound
   * messages are still stored — moved the lockout to `TenantStatusGuard`, which
   * is an HTTP guard. This dispatcher runs in a queue worker. For one review
   * cycle that meant a suspended tenant's queued replies were still delivered to
   * real customers, with nothing failing and no test noticing.
   */
  describe('a tenant that may not send', () => {
    it.each(['suspended', 'cancelled'] as const)('refuses to deliver on %s', async (status) => {
      findFirstTenant.mockResolvedValue({ status });

      await dispatcher.deliver(JOB, 1);

      expect(sendText).not.toHaveBeenCalled();
      expect(sendTemplate).not.toHaveBeenCalled();
    });

    it('fails the message rather than leaving it queued for ever', async () => {
      findFirstTenant.mockResolvedValue({ status: 'suspended' });

      await dispatcher.deliver(JOB, 1);

      // Left `queued` it would be stranded — the job is consumed and nothing
      // re-triggers it — or delivered weeks later when the tenant came back.
      expect(writtenBy(updateMany).status).toBe('failed');
    });

    it('tells the agent why, in words rather than a code', async () => {
      findFirstTenant.mockResolvedValue({ status: 'suspended' });

      await dispatcher.deliver(JOB, 1);

      // `MessageResponse.failureReason` renders this, so it names the workspace
      // state and the remedy and nothing about the data layer.
      expect(writtenBy(updateMany).errorMessage).toContain('not active');
    });

    it('still sends for a past_due tenant, because dunning is a banner', async () => {
      // The check reads `TENANT_STATUS_EFFECTS` rather than restating a list, so
      // this is the case that proves it did not simply refuse everything that is
      // not `active`.
      findFirstTenant.mockResolvedValue({ status: 'past_due' });

      await dispatcher.deliver(JOB, 1);

      expect(sendText).toHaveBeenCalled();
    });

    it('refuses when the tenant row has gone, which is the fail-closed direction', async () => {
      findFirstTenant.mockResolvedValue(null);

      await dispatcher.deliver(JOB, 1);

      expect(sendText).not.toHaveBeenCalled();
    });
  });
});
