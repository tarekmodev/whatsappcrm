import { MessageResponseSchema } from '@whatsappcrm/contracts';
import type { MessageRow } from './message.mapper';
import { toMessageResponse } from './message.mapper';

/**
 * The three published fields that are not columns. Each of them is a decision,
 * and each fails invisibly if it is wrong: a status the contract has no name
 * for, an agent's reply attributed to a robot, or an attachment URL that is a
 * path and therefore resolves against whatever origin the console happens to be
 * on.
 */

const ORIGIN = 'https://acme.example';

function row(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: '68444444-4444-7444-8444-4444444444e0',
    conversationId: '68444444-4444-7444-8444-4444444444c1',
    direction: 'inbound',
    contentType: 'text',
    status: 'received',
    body: 'Where is my order?',
    senderUserId: null,
    origin: 'contact',
    providerMessageId: 'wamid.1',
    errorCode: null,
    errorMessage: null,
    sentAt: new Date('2026-08-11T09:00:00.000Z'),
    createdAt: new Date('2026-08-11T09:00:01.000Z'),
    attachments: [],
    ...overrides,
  };
}

describe('toMessageResponse', () => {
  it('produces the published shape', () => {
    expect(() => MessageResponseSchema.parse(toMessageResponse(row(), ORIGIN))).not.toThrow();
  });

  it('publishes an inbound message as delivered', () => {
    // `received` is the stored terminal state of an inbound message and has no
    // rung on `MESSAGE_STATUS_RANK`. The contract's answer is that an inbound
    // message is born delivered — it is already in our hands.
    expect(toMessageResponse(row(), ORIGIN).status).toBe('delivered');
  });

  it('passes an outbound status through unchanged', () => {
    expect(toMessageResponse(row({ direction: 'outbound', status: 'queued' }), ORIGIN).status).toBe(
      'queued',
    );
  });

  it('does not call an inbound message automation', () => {
    expect(toMessageResponse(row(), ORIGIN).sentByAutomation).toBe(false);
  });

  it('calls an outbound message with no sender automation', () => {
    // The chatbot, a workflow, or the placeholder a status webhook creates.
    expect(
      toMessageResponse(row({ direction: 'outbound', status: 'sent' }), ORIGIN).sentByAutomation,
    ).toBe(true);
  });

  it('attributes an agent reply to the agent', () => {
    const message = toMessageResponse(
      row({
        direction: 'outbound',
        status: 'queued',
        senderUserId: '68444444-4444-7444-8444-4444444444a1',
      }),
      ORIGIN,
    );

    expect(message.sentByAutomation).toBe(false);
    expect(message.sentByUserId).toBe('68444444-4444-7444-8444-4444444444a1');
  });

  it('makes a stored attachment URL absolute against this request origin', () => {
    const message = toMessageResponse(
      row({
        contentType: 'image',
        attachments: [
          {
            id: '68444444-4444-7444-8444-4444444444f1',
            providerMediaId: 'meta-1',
            url: '/api/v1/media/68444444-4444-7444-8444-4444444444f1/content',
            kind: 'image',
            downloadState: 'stored',
            mimeType: 'image/png',
            filename: 'receipt.png',
            sizeBytes: 1_024,
          },
        ],
      }),
      ORIGIN,
    );

    expect(message.attachments[0]?.url).toBe(
      'https://acme.example/api/v1/media/68444444-4444-7444-8444-4444444444f1/content',
    );
    // And the published schema demands an absolute one, which is the reason the
    // origin is joined on here rather than stored.
    expect(() => MessageResponseSchema.parse(message)).not.toThrow();
  });

  it('leaves a pending attachment URL null rather than inventing one', () => {
    const message = toMessageResponse(
      row({
        contentType: 'image',
        attachments: [
          {
            id: '68444444-4444-7444-8444-4444444444f1',
            providerMediaId: 'meta-1',
            url: null,
            kind: 'image',
            downloadState: 'pending',
            mimeType: 'image/png',
            filename: null,
            sizeBytes: null,
          },
        ],
      }),
      ORIGIN,
    );

    expect(message.attachments[0]?.url).toBeNull();
  });

  it('joins Meta code and title into one failure reason', () => {
    expect(
      toMessageResponse(
        row({
          direction: 'outbound',
          status: 'failed',
          errorCode: '131047',
          errorMessage: 'Re-engagement message',
        }),
        ORIGIN,
      ).failureReason,
    ).toBe('131047: Re-engagement message');
  });

  it('has no failure reason for a message that did not fail', () => {
    expect(toMessageResponse(row(), ORIGIN).failureReason).toBeNull();
  });
});
