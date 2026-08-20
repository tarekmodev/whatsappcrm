import { describe, expect, it } from 'vitest';
import type { MessageResponse } from '@whatsappcrm/contracts';
import { groupMessagesByDay } from './message-days';

function message(id: string, sentAt: string): MessageResponse {
  return {
    id,
    conversationId: '0192f004-0000-7000-8000-000000000401',
    direction: 'inbound',
    type: 'text',
    status: 'delivered',
    body: 'Hello',
    attachments: [],
    sentByUserId: null,
    sentByAutomation: false,
    origin: 'contact',
    providerMessageId: null,
    failureReason: null,
    sentAt,
    createdAt: sentAt,
  };
}

describe('groupMessagesByDay', () => {
  it('puts consecutive messages from one day in one group', () => {
    const days = groupMessagesByDay([
      message('a', '2026-08-11T09:00:00.000Z'),
      message('b', '2026-08-11T21:30:00.000Z'),
      message('c', '2026-08-12T06:15:00.000Z'),
    ]);

    expect(days.map((day) => day.key)).toEqual(['2026-08-11', '2026-08-12']);
    expect(days[0]?.messages.map((item) => item.id)).toEqual(['a', 'b']);
    expect(days[1]?.messages.map((item) => item.id)).toEqual(['c']);
  });

  it('labels each group with its date', () => {
    const days = groupMessagesByDay([message('a', '2026-08-12T06:15:00.000Z')]);

    expect(days[0]?.label).toBe('12 August 2026');
    // The chip's machine-readable value is the exact instant, not the day.
    expect(days[0]?.isoTimestamp).toBe('2026-08-12T06:15:00.000Z');
  });

  it('groups on the UTC calendar whatever the machine’s zone is', () => {
    // Grouping in the reader's zone would put a different number of chips in the
    // server's HTML than in the browser's — a hydration mismatch in the shape of
    // the list, which no amount of deferring fixes.
    const days = groupMessagesByDay([
      message('a', '2026-08-11T23:30:00.000Z'),
      message('b', '2026-08-12T00:30:00.000Z'),
    ]);

    expect(days).toHaveLength(2);
  });

  it('returns nothing for an empty thread', () => {
    expect(groupMessagesByDay([])).toEqual([]);
  });
});
