import { MESSAGE_TYPES } from '@whatsappcrm/contracts';
import { MessageContentType } from '../generated/prisma/enums';
import {
  toContentType,
  toFailureReason,
  toMessageBody,
  toMessageStatus,
  toPhoneE164,
} from './whatsapp-message.mapper';
import type { WhatsAppInboundMessage } from './whatsapp-payload.schema';

function message(overrides: Partial<WhatsAppInboundMessage>): WhatsAppInboundMessage {
  return {
    id: 'wamid.1',
    from: '966501234567',
    timestamp: new Date('2026-08-10T10:00:00Z'),
    type: 'text',
    ...overrides,
  };
}

describe('toContentType', () => {
  it.each([
    'text',
    'image',
    'video',
    'audio',
    'document',
    'sticker',
    'location',
    'contacts',
    'interactive',
    'system',
  ])('maps Meta’s `%s` onto the matching stored type', (metaType) => {
    expect(toContentType(metaType)).toBe(metaType);
  });

  /**
   * The rule TAR-39 states as "recorded rather than dropped". `reaction`,
   * `order` and `button` all shipped after the Cloud API launched, and the next
   * one will too — none of them may fail a batch of real customer messages.
   */
  it.each(['reaction', 'order', 'button', 'something_meta_ships_in_2027'])(
    'records `%s` as unsupported rather than failing',
    (metaType) => {
      expect(toContentType(metaType)).toBe(MessageContentType.unsupported);
    },
  );

  it('produces only values the published contract knows about', () => {
    const produced = ['text', 'reaction'].map(toContentType);

    expect(MESSAGE_TYPES).toEqual(expect.arrayContaining(produced));
  });
});

describe('toMessageStatus', () => {
  it.each(['sent', 'delivered', 'read', 'failed'])('maps `%s`', (metaStatus) => {
    expect(toMessageStatus(metaStatus)).toBe(metaStatus);
  });

  /** `deleted` is real and unmodelled. Guessing would move a message along a ladder it was never on. */
  it.each(['deleted', 'warning'])('returns undefined for the unmodelled `%s`', (metaStatus) => {
    expect(toMessageStatus(metaStatus)).toBeUndefined();
  });
});

describe('toMessageBody', () => {
  it('reads a text body', () => {
    expect(toMessageBody(message({ text: { body: 'hello' } }))).toBe('hello');
  });

  it.each(['image', 'video', 'audio', 'document'] as const)('reads a %s caption', (kind) => {
    expect(toMessageBody(message({ type: kind, [kind]: { caption: 'look' } }))).toBe('look');
  });

  it('reads the label of a tapped button', () => {
    expect(toMessageBody(message({ type: 'button', button: { text: 'Track order' } }))).toBe(
      'Track order',
    );
  });

  it.each([
    ['button_reply', { button_reply: { title: 'Yes' } }],
    ['list_reply', { list_reply: { title: 'Yes' } }],
  ])('reads an interactive %s title', (_case, interactive) => {
    expect(toMessageBody(message({ type: 'interactive', interactive }))).toBe('Yes');
  });

  it('reads a reaction emoji', () => {
    expect(toMessageBody(message({ type: 'reaction', reaction: { emoji: '👍' } }))).toBe('👍');
  });

  it('returns null for a type that carries no text', () => {
    expect(toMessageBody(message({ type: 'location' }))).toBeNull();
  });

  it('treats an empty body as no body', () => {
    expect(toMessageBody(message({ text: { body: '' } }))).toBeNull();
  });
});

describe('toPhoneE164', () => {
  it('adds the leading + Meta omits', () => {
    expect(toPhoneE164('966501234567')).toBe('+966501234567');
  });

  it('leaves an already-prefixed number alone', () => {
    expect(toPhoneE164('+966501234567')).toBe('+966501234567');
  });

  /**
   * Returning null rather than storing it is the point: the contact dedupe key
   * is `(tenant_id, phone_e164)`, so a malformed value creates a contact that
   * the next message from the same person will never match.
   */
  it.each(['not-a-number', '0966501234567', '', '+'])('rejects `%s`', (waId) => {
    expect(toPhoneE164(waId)).toBeNull();
  });
});

describe('toFailureReason', () => {
  it('flattens Meta’s first error onto the two columns messages has', () => {
    expect(toFailureReason([{ code: 131047, title: 'Re-engagement message' }])).toEqual({
      errorCode: '131047',
      errorMessage: 'Re-engagement message',
    });
  });

  it('nulls both when Meta sent no error detail', () => {
    expect(toFailureReason(undefined)).toEqual({ errorCode: null, errorMessage: null });
    expect(toFailureReason([])).toEqual({ errorCode: null, errorMessage: null });
  });

  it('accepts a string code, which Meta also sends', () => {
    expect(toFailureReason([{ code: '470' }]).errorCode).toBe('470');
  });
});
