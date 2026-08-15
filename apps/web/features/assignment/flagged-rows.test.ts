import { describe, expect, it } from 'vitest';
import type { TeamResponse, TicketResponse } from '@whatsappcrm/contracts';
import { toFlaggedTicketRows } from './flagged-rows';

/**
 * The narrowing every cell in the queue depends on: a row exists only when the
 * routing columns agree with each other, so nothing downstream has to defend
 * against a null the database's `CHECK` makes unreachable.
 */

const TEAMS: TeamResponse[] = [
  {
    id: '0192f002-0000-7000-8000-000000000201',
    name: 'Billing',
    description: null,
    memberUserIds: [],
    createdAt: '2026-07-02T10:10:00.000Z',
  },
];

function ticket(overrides: Partial<TicketResponse> = {}): TicketResponse {
  return {
    id: '0192f00a-0000-7000-8000-000000000a01',
    number: 1041,
    conversationId: null,
    contactId: null,
    subject: 'Refund still not showing',
    status: 'open',
    priority: 'normal',
    assignedUserId: null,
    assignedTeamId: null,
    routing: {
      state: 'deferred',
      deferredReason: 'all_at_capacity',
      deferredSince: '2026-08-10T07:12:00.000Z',
    },
    sla: {
      policyId: null,
      firstResponseState: 'not_applicable',
      firstResponseDueAt: null,
      resolutionState: 'not_applicable',
      resolutionDueAt: null,
    },
    firstRespondedAt: null,
    resolvedAt: null,
    closedAt: null,
    createdAt: '2026-08-10T07:10:00.000Z',
    updatedAt: '2026-08-10T07:12:00.000Z',
    ...overrides,
  };
}

describe('toFlaggedTicketRows', () => {
  it('narrows the reason and the flagged timestamp to non-null', () => {
    const [row] = toFlaggedTicketRows([ticket()], TEAMS);

    expect(row?.reason).toBe('all_at_capacity');
    expect(row?.flaggedSince).toBe('2026-08-10T07:12:00.000Z');
  });

  it('names the team routing tried', () => {
    const [row] = toFlaggedTicketRows([ticket({ assignedTeamId: TEAMS[0]?.id ?? '' })], TEAMS);

    expect(row?.routedToTeamName).toBe('Billing');
  });

  it('reads a ticket with no team as the workspace pool', () => {
    const [row] = toFlaggedTicketRows([ticket()], TEAMS);

    expect(row?.routedToTeamName).toBeNull();
  });

  it('falls back to the pool rather than rendering a team id that no longer resolves', () => {
    const [row] = toFlaggedTicketRows(
      [ticket({ assignedTeamId: '0192f002-0000-7000-8000-0000000002ff' })],
      TEAMS,
    );

    expect(row?.routedToTeamName).toBeNull();
  });

  it('drops a ticket whose routing columns disagree instead of rendering half a row', () => {
    const inconsistent = ticket({
      routing: { state: 'deferred', deferredReason: null, deferredSince: null },
    });

    expect(toFlaggedTicketRows([inconsistent], TEAMS)).toEqual([]);
  });

  it('preserves the order it was given, whatever the API chose', () => {
    const rows = toFlaggedTicketRows(
      [
        ticket({
          id: 'a',
          routing: { ...ticket().routing, deferredSince: '2026-08-10T07:00:00.000Z' },
        }),
        ticket({
          id: 'b',
          routing: { ...ticket().routing, deferredSince: '2026-08-10T09:00:00.000Z' },
        }),
      ],
      TEAMS,
    );

    expect(rows.map((row) => row.ticket.id)).toEqual(['a', 'b']);
  });
});
