import type { ConversationResponse } from '@whatsappcrm/contracts';
import { describe, expect, it } from 'vitest';
import { content } from '@/content/en';
import { CHIP_LIMIT, conversationChips, type InboxFilterContext } from './conversation-chips';

const CONTACT: ConversationResponse['contact'] = {
  id: '0192f003-0000-7000-8000-000000000301',
  phone: '+966501234567',
  waProfileName: 'Fatima Al-Zahra',
  displayName: 'Fatima Al-Zahra',
  email: null,
  tags: [],
  customFields: {},
  lastContactedAt: null,
  optedOutAt: null,
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
};

const BASE: ConversationResponse = {
  id: '0192f004-0000-7000-8000-000000000401',
  contact: CONTACT,
  whatsappAccountId: '0192f005-0000-7000-8000-000000000501',
  status: 'open',
  assignedUserId: '0192f001-0000-7000-8000-000000000101',
  assignedTeamId: null,
  ticketId: null,
  unreadCount: 0,
  serviceWindowExpiresAt: null,
  botHandling: false,
  botState: 'off',
  lastMessagePreview: 'Hello',
  lastMessageAt: '2026-08-01T09:00:00.000Z',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
};

const ALL: InboxFilterContext = { scope: 'all', status: undefined };

function chips(
  conversation: Partial<ConversationResponse>,
  filter: InboxFilterContext = ALL,
  limit: number = CHIP_LIMIT.row,
): string[] {
  return conversationChips({ ...BASE, ...conversation }, filter, limit).map((chip) => chip.label);
}

describe('conversationChips', () => {
  it('says nothing about an ordinary open conversation somebody holds', () => {
    expect(chips({})).toEqual([]);
  });

  it('never labels `open`, whatever the filter', () => {
    expect(chips({ status: 'open' }, { scope: 'assigned', status: undefined })).toEqual([]);
  });

  it('labels the statuses that are not the ordinary case', () => {
    expect(chips({ status: 'resolved' })).toEqual([content.conversationStatuses.resolved]);
    expect(chips({ status: 'pending' })).toEqual([content.conversationStatuses.pending]);
  });

  it('drops a status the active filter has already named', () => {
    expect(chips({ status: 'resolved' }, { scope: 'all', status: 'resolved' })).toEqual([]);
  });

  it('drops "Unclaimed" under the filter that selects for it', () => {
    const unclaimed = { assignedUserId: null, assignedTeamId: null } as const;

    expect(chips(unclaimed)).toEqual([content.inbox.unclaimed]);
    expect(chips(unclaimed, { scope: 'unassigned', status: undefined })).toEqual([]);
  });

  it('gives a row its one slot to whatever needs a person soonest', () => {
    expect(chips({ status: 'pending', botState: 'handed_off', assignedUserId: null })).toEqual([
      content.inbox.botStates.handed_off,
    ]);
  });

  it('ranks an unclaimed thread above the bot still answering one', () => {
    expect(chips({ botState: 'bot_active', assignedUserId: null })).toEqual([
      content.inbox.unclaimed,
    ]);
  });

  it('lets a detail header carry two, in the same order', () => {
    expect(
      chips(
        { status: 'pending', botState: 'handed_off', assignedUserId: null },
        ALL,
        CHIP_LIMIT.detail,
      ),
    ).toEqual([content.inbox.botStates.handed_off, content.inbox.unclaimed]);
  });

  it('never exceeds the limit it was given', () => {
    const loud = {
      status: 'closed',
      botState: 'handed_off',
      assignedUserId: null,
      assignedTeamId: null,
    } as const;

    expect(chips(loud)).toHaveLength(CHIP_LIMIT.row);
    expect(chips(loud, ALL, CHIP_LIMIT.detail)).toHaveLength(CHIP_LIMIT.detail);
  });
});
