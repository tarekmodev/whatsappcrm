import { describe, expect, it } from 'vitest';
import type { AgentCapacity, UserResponse } from '@whatsappcrm/contracts';
import { findCapacityRow, toAgentCapacityRows } from './capacity';

/**
 * The rule that decides who the cap-edit control offers, and in what order.
 *
 * Both halves matter for the same reason: a supervisor opens this because a
 * ticket says everybody is full, so the list has to put the agents whose limit is
 * actually in the way first, and must never show a limit it does not know.
 */

function agent(
  id: string,
  displayName: string,
  assignmentCapacity: AgentCapacity | null,
): UserResponse {
  return {
    id,
    email: `${id}@northwind.example`,
    displayName,
    avatarUrl: null,
    role: 'agent',
    status: 'active',
    availability: 'available',
    teamIds: [],
    occupiesSeat: true,
    lastSeenAt: null,
    security: null,
    assignmentCapacity,
    createdAt: '2026-07-02T10:00:00.000Z',
  };
}

function capacity(activeTicketCount: number, effective: number, own: number | null): AgentCapacity {
  return {
    maxConcurrentTickets: own,
    effectiveMaxConcurrentTickets: effective,
    activeTicketCount,
  };
}

describe('toAgentCapacityRows', () => {
  it('lists agents at their limit first, then the busiest', () => {
    const rows = toAgentCapacityRows([
      agent('a', 'Aisha', capacity(1, 5, null)),
      agent('b', 'Bruno', capacity(4, 5, null)),
      agent('c', 'Chen', capacity(2, 2, 2)),
    ]);

    expect(rows.map((row) => row.user.displayName)).toEqual(['Chen', 'Bruno', 'Aisha']);
  });

  it('breaks a tie by name, so the order does not move between renders', () => {
    const rows = toAgentCapacityRows([
      agent('b', 'Bruno', capacity(2, 5, null)),
      agent('a', 'Aisha', capacity(2, 5, null)),
    ]);

    expect(rows.map((row) => row.user.displayName)).toEqual(['Aisha', 'Bruno']);
  });

  it('counts an agent at exactly their limit as being at it', () => {
    const [row] = toAgentCapacityRows([agent('a', 'Aisha', capacity(3, 3, 3))]);

    expect(row?.isAtCapacity).toBe(true);
  });

  /**
   * `null` is "you may not know this" — what the serializer sends a caller
   * holding neither `assignment_rule:read` nor `:write`. The console cannot say
   * what that agent's limit is, and a row rendered anyway would be a number
   * nobody chose.
   */
  it('drops an agent whose capacity was withheld, rather than guessing one', () => {
    const rows = toAgentCapacityRows([
      agent('a', 'Aisha', null),
      agent('c', 'Chen', capacity(0, 5, null)),
    ]);

    expect(rows.map((row) => row.user.displayName)).toEqual(['Chen']);
  });
});

describe('findCapacityRow', () => {
  it('answers null for an agent the list no longer holds', () => {
    const rows = toAgentCapacityRows([agent('a', 'Aisha', capacity(0, 5, null))]);

    expect(findCapacityRow(rows, 'a')?.user.displayName).toBe('Aisha');
    expect(findCapacityRow(rows, 'gone')).toBeNull();
  });
});
