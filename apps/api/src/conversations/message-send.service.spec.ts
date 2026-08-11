import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  permissionsForRole,
  type SendMessageInput,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import { ResponseOriginService } from '../common/response-origin.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { MESSAGE_CREATED_EVENT } from '../events/domain-events';
import type { MediaSendResolver } from '../media/media-send.resolver';
import { MediaNotFoundError } from '../media/media.errors';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { QueueService } from '../queue/queue.service';
import type { MessageTemplateQueryService } from '../whatsapp/message-template-query.service';
import type { ConversationQueryService } from './conversation-query.service';
import { CONVERSATIONS_QUEUE, SEND_OUTBOUND_MESSAGE_JOB } from './conversations.constants';
import {
  ContactOptedOutError,
  ServiceWindowExpiredError,
  TemplateNotSendableError,
} from './conversations.errors';
import { MessageSendService } from './message-send.service';

/**
 * The send endpoint's two hard rules, both stated as acceptance criteria:
 *
 *   * inside the 24-hour service window a free-form message is accepted, and
 *     outside it only an approved template is;
 *   * nothing is written before every refusal has been made, so a rejected send
 *     leaves no row and no queued job behind.
 *
 * The queue and Meta are both fakes here on purpose. What is under test is the
 * decision, not the transport — the delivery worker has its own spec, and the
 * end-to-end path has an integration test against a real database.
 */

const TENANT = '68444444-4444-7444-8444-444444444401';
const CONVERSATION = '68444444-4444-7444-8444-4444444444c1';
const CONTACT = '68444444-4444-7444-8444-4444444444d1';
const NUMBER = '68444444-4444-7444-8444-4444444444a0';
const MESSAGE = '68444444-4444-7444-8444-4444444444e0';
const MEDIA = '68444444-4444-7444-8444-4444444444f1';

const PRINCIPAL: SessionPrincipal = {
  userId: '68444444-4444-7444-8444-4444444444a1',
  tenantId: TENANT,
  email: 'agent@example.invalid',
  displayName: 'Ada Agent',
  role: 'agent',
  permissions: [...permissionsForRole('agent')],
  teamIds: [],
  sessionId: '68444444-4444-7444-8444-4444444444e1',
  expiresAt: '2036-12-31T23:59:59.000Z',
};

const OPEN_WINDOW = new Date(Date.now() + 60 * 60 * 1_000);
const CLOSED_WINDOW = new Date(Date.now() - 60 * 60 * 1_000);

const APPROVED_TEMPLATE = {
  row: {
    id: '68444444-4444-7444-8444-4444444444ba',
    whatsappBusinessAccountId: '68444444-4444-7444-8444-4444444444bb',
    name: 'order_shipped',
    language: 'en_US',
    category: 'UTILITY',
    status: 'approved' as const,
    components: null,
    providerTemplateId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  summary: {
    bodyText: 'Hi {{1}}, your order has shipped.',
    parameterCount: 1,
    headerFormat: null,
    headerParameterCount: 0,
    requiresButtonParameters: false,
  },
};

describe('MessageSendService', () => {
  let tenantContext: TenantContextService;
  let service: MessageSendService;
  let createdMessages: Record<string, unknown>[];
  let enqueue: jest.Mock;
  let findApprovedForNumber: jest.Mock;
  let describeForSend: jest.Mock;
  let emit: jest.Mock;
  let serviceWindowExpiresAt: Date | null;
  let optedOutAt: Date | null;

  function inScope<T>(work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      {
        requestId: 'send-spec',
        tenantId: TENANT,
        userId: PRINCIPAL.userId,
        principal: PRINCIPAL,
        hostname: 'acme.example',
      },
      async () => await work(),
    );
  }

  function send(input: SendMessageInput): Promise<unknown> {
    return inScope(async () => await service.send(CONVERSATION, input));
  }

  beforeEach(() => {
    createdMessages = [];
    serviceWindowExpiresAt = OPEN_WINDOW;
    optedOutAt = null;
    enqueue = jest.fn(() => Promise.resolve('added'));
    findApprovedForNumber = jest.fn(() => Promise.resolve(null));
    describeForSend = jest.fn(() =>
      Promise.resolve({
        id: MEDIA,
        kind: 'image' as const,
        source: 'upload' as const,
        mimeType: 'image/png',
        sizeBytes: 1_024,
        fileName: 'receipt.png',
        createdAt: new Date(),
      }),
    );
    emit = jest.fn();

    const transactionClient = {
      message: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          createdMessages.push(data);

          return Promise.resolve({ id: MESSAGE });
        }),
        findUniqueOrThrow: jest.fn(() =>
          Promise.resolve(storedMessage(createdMessages.at(-1) ?? {})),
        ),
      },
      messageAttachment: { create: jest.fn(() => Promise.resolve({ id: 'attachment' })) },
      conversation: { updateMany: jest.fn(() => Promise.resolve({ count: 1 })) },
    };

    const prisma = {
      $tenantTransaction: (work: (tx: unknown) => Promise<unknown>) => work(transactionClient),
      conversation: {
        findUniqueOrThrow: jest.fn(() =>
          Promise.resolve({
            id: CONVERSATION,
            whatsappAccountId: NUMBER,
            contactId: CONTACT,
            serviceWindowExpiresAt,
            contact: { phoneE164: '+966500000001', optedOutAt },
          }),
        ),
      },
    } as unknown as TenantPrisma;

    tenantContext = new TenantContextService();
    service = new MessageSendService(
      prisma,
      tenantContext,
      { require: jest.fn(() => Promise.resolve({})) } as unknown as ConversationQueryService,
      { findApprovedForNumber } as unknown as MessageTemplateQueryService,
      { describeForSend } as unknown as MediaSendResolver,
      { enqueue } as unknown as QueueService,
      { emit } as unknown as EventEmitter2,
      new ResponseOriginService({ getOrThrow: () => 'https' } as never, tenantContext),
    );
  });

  describe('inside the 24-hour service window', () => {
    it('accepts a free-form message and returns it queued', async () => {
      const message = await send({ type: 'text', body: 'On its way.' });

      expect(message).toMatchObject({ status: 'queued', body: 'On its way.', type: 'text' });
      expect(createdMessages).toHaveLength(1);
    });

    it('queues the delivery rather than sending inline', async () => {
      await send({ type: 'text', body: 'On its way.' });

      expect(enqueue).toHaveBeenCalledWith(
        CONVERSATIONS_QUEUE,
        SEND_OUTBOUND_MESSAGE_JOB,
        { tenantId: TENANT, messageId: MESSAGE },
        expect.objectContaining({ attempts: expect.any(Number) as number }),
      );
    });

    it('publishes the message to the realtime bus after the commit', async () => {
      await send({ type: 'text', body: 'On its way.' });

      expect(emit).toHaveBeenCalledWith(
        MESSAGE_CREATED_EVENT,
        expect.objectContaining({
          tenantId: TENANT,
          conversationId: CONVERSATION,
          contactId: CONTACT,
        }),
      );
    });

    it('records the caption as the body of a media send', async () => {
      await send({ type: 'image', mediaId: MEDIA, caption: 'The receipt' });

      expect(createdMessages[0]).toMatchObject({ contentType: 'image', body: 'The receipt' });
    });

    it('refuses media whose kind is not the kind the send declared', async () => {
      describeForSend.mockResolvedValueOnce({
        id: MEDIA,
        kind: 'document',
        source: 'upload',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        fileName: 'invoice.pdf',
        createdAt: new Date(),
      });

      await expect(send({ type: 'image', mediaId: MEDIA })).rejects.toThrow(/document/);
      expect(createdMessages).toHaveLength(0);
    });

    it('refuses a mediaId this tenant does not own, without writing a row', async () => {
      describeForSend.mockRejectedValueOnce(new MediaNotFoundError(MEDIA));

      await expect(send({ type: 'image', mediaId: MEDIA })).rejects.toThrow(/uploaded file/);
      expect(createdMessages).toHaveLength(0);
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('outside the 24-hour service window', () => {
    beforeEach(() => {
      serviceWindowExpiresAt = CLOSED_WINDOW;
    });

    it('refuses a free-form message, and writes nothing', async () => {
      await expect(send({ type: 'text', body: 'Still there?' })).rejects.toBeInstanceOf(
        ServiceWindowExpiredError,
      );
      expect(createdMessages).toHaveLength(0);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('refuses a free-form message on a thread that never had a window', async () => {
      serviceWindowExpiresAt = null;

      await expect(send({ type: 'image', mediaId: MEDIA })).rejects.toBeInstanceOf(
        ServiceWindowExpiredError,
      );
    });

    it('accepts an approved template', async () => {
      findApprovedForNumber.mockResolvedValueOnce(APPROVED_TEMPLATE);

      const message = await send({
        type: 'template',
        templateName: 'order_shipped',
        languageCode: 'en_US',
        variables: ['Maria'],
      });

      expect(message).toMatchObject({ status: 'queued', type: 'template' });
      // The approved body, rendered locally so the thread is readable.
      expect(createdMessages[0]).toMatchObject({ body: 'Hi Maria, your order has shipped.' });
    });

    it('carries the template inputs on the job, because no column holds them', async () => {
      findApprovedForNumber.mockResolvedValueOnce(APPROVED_TEMPLATE);

      await send({
        type: 'template',
        templateName: 'order_shipped',
        languageCode: 'en_US',
        variables: ['Maria'],
      });

      expect(enqueue).toHaveBeenCalledWith(
        CONVERSATIONS_QUEUE,
        SEND_OUTBOUND_MESSAGE_JOB,
        expect.objectContaining({
          template: { name: 'order_shipped', languageCode: 'en_US', variables: ['Maria'] },
        }),
        expect.anything(),
      );
    });

    it('refuses a template that is not approved for this number', async () => {
      findApprovedForNumber.mockResolvedValueOnce(null);

      await expect(
        send({
          type: 'template',
          templateName: 'not_approved_yet',
          languageCode: 'en_US',
          variables: [],
        }),
      ).rejects.toBeInstanceOf(TemplateNotSendableError);
      expect(createdMessages).toHaveLength(0);
    });

    it('refuses a template whose variables do not match the approved body', async () => {
      findApprovedForNumber.mockResolvedValueOnce(APPROVED_TEMPLATE);

      await expect(
        send({
          type: 'template',
          templateName: 'order_shipped',
          languageCode: 'en_US',
          variables: [],
        }),
      ).rejects.toThrow(/takes 1 variable\(s\) and 0 were supplied/);
    });
  });

  it('refuses every send to a contact who has opted out, template included', async () => {
    optedOutAt = new Date('2026-01-01T00:00:00.000Z');
    findApprovedForNumber.mockResolvedValue(APPROVED_TEMPLATE);

    await expect(send({ type: 'text', body: 'hello' })).rejects.toBeInstanceOf(
      ContactOptedOutError,
    );
    await expect(
      send({
        type: 'template',
        templateName: 'order_shipped',
        languageCode: 'en_US',
        variables: ['Maria'],
      }),
    ).rejects.toBeInstanceOf(ContactOptedOutError);
    expect(createdMessages).toHaveLength(0);
  });
});

/** The row the transaction reads back, shaped as `MESSAGE_PROJECTION` selects it. */
function storedMessage(data: Record<string, unknown>): Record<string, unknown> {
  return {
    id: MESSAGE,
    conversationId: CONVERSATION,
    direction: 'outbound',
    contentType: data.contentType ?? 'text',
    status: 'queued',
    body: data.body ?? null,
    senderUserId: PRINCIPAL.userId,
    providerMessageId: null,
    errorCode: null,
    errorMessage: null,
    sentAt: new Date('2026-08-11T12:00:00.000Z'),
    createdAt: new Date('2026-08-11T12:00:00.000Z'),
    attachments: [],
  };
}
