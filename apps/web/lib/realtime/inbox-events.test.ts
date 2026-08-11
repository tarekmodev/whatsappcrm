import { describe, expect, it } from 'vitest';
import { INBOX_SERVER_EVENTS, inboxEffectOf } from './inbox-events';

/**
 * The console's whole realtime decision. Worth testing directly because a wrong
 * answer here is either an inbox that stops updating or one that re-renders the
 * route on every keystroke somebody else makes.
 */

const MESSAGE = {
  id: '0192f006-0000-7000-8000-000000000601',
  conversationId: '0192f004-0000-7000-8000-000000000401',
  direction: 'inbound',
  type: 'text',
  status: 'delivered',
  body: 'Hello',
  attachments: [],
  sentByUserId: null,
  sentByAutomation: false,
  providerMessageId: null,
  failureReason: null,
  sentAt: '2026-08-10T08:05:00.000Z',
  createdAt: '2026-08-10T08:05:00.000Z',
};

describe('inboxEffectOf', () => {
  it('refetches on a new message', () => {
    expect(
      inboxEffectOf({
        event: 'message.created',
        conversationId: MESSAGE.conversationId,
        message: MESSAGE,
      }),
    ).toBe('refetch');
  });

  it('refetches on a delivery status change', () => {
    expect(
      inboxEffectOf({
        event: 'message.status_changed',
        conversationId: MESSAGE.conversationId,
        messageId: MESSAGE.id,
        message: { ...MESSAGE, direction: 'outbound', status: 'read' },
      }),
    ).toBe('refetch');
  });

  it('refetches on a note, so a colleague’s note appears without a reload', () => {
    expect(
      inboxEffectOf({
        event: 'note.created',
        conversationId: MESSAGE.conversationId,
        noteId: '0192f008-0000-7000-8000-000000000801',
        authorUserId: '0192f001-0000-7000-8000-000000000102',
      }),
    ).toBe('refetch');
  });

  it('hands a revoked session to the route guard rather than refetching quietly', () => {
    expect(
      inboxEffectOf({
        event: 'session.revoked',
        sessionId: '0192f009-0000-7000-8000-000000000901',
      }),
    ).toBe('signed-out');
  });

  it('ignores a typing indicator, which would refetch on every keystroke', () => {
    expect(
      inboxEffectOf({
        event: 'agent.typing',
        conversationId: MESSAGE.conversationId,
        userId: '0192f001-0000-7000-8000-000000000102',
        expiresAt: '2026-08-10T08:05:10.000Z',
      }),
    ).toBe('ignore');
  });

  it('ignores a frame that does not match the contract instead of throwing', () => {
    // A throw inside a socket listener takes the connection down with it, and a
    // frame is not something a user can retry.
    expect(inboxEffectOf({ event: 'message.created' })).toBe('ignore');
    expect(inboxEffectOf('not an object')).toBe('ignore');
    expect(inboxEffectOf(null)).toBe('ignore');
  });
});

describe('INBOX_SERVER_EVENTS', () => {
  it('subscribes to nothing the effect table would ignore', () => {
    expect(INBOX_SERVER_EVENTS).not.toContain('agent.typing');
    expect(INBOX_SERVER_EVENTS).not.toContain('ticket.updated');
  });
});
