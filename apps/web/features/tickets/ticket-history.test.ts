import { describe, expect, it } from 'vitest';
import type { TicketEvent } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { toHistoryEntries, toHistoryEntry } from './ticket-history';

/**
 * The event → entry mapping, which is the part of the history worth testing:
 * the renderer only places what this produces, and the per-type encoding table
 * in `TicketEventSchema` is a contract the console has to honour exactly.
 *
 * TAR-32's third acceptance criterion — actor, reason and timestamp on
 * reassignment and escalation entries — is the first two describes.
 */

const AMINA = '0192f001-0000-7000-8000-000000000101';
const PRIYA = '0192f001-0000-7000-8000-000000000102';
const LIANG = '0192f001-0000-7000-8000-000000000104';
const BILLING = '0192f002-0000-7000-8000-000000000201';
const TICKET = '0192f00a-0000-7000-8000-000000000a01';

const NAMES = {
  userNames: new Map([
    [AMINA, 'Amina Haddad'],
    [PRIYA, 'Priya Raman'],
    [LIANG, 'Liang Wei'],
  ]),
  teamNames: new Map([[BILLING, 'Billing']]),
};

function event(overrides: Partial<TicketEvent> & Pick<TicketEvent, 'type'>): TicketEvent {
  return {
    id: '0192f010-0000-7000-8000-000000001001',
    ticketId: TICKET,
    actorUserId: null,
    fromValue: null,
    toValue: null,
    assignment: null,
    reason: null,
    cause: null,
    createdAt: '2026-08-10T08:45:00.000Z',
    ...overrides,
  };
}

describe('a reassignment entry', () => {
  const reassigned = event({
    type: 'assigned',
    actorUserId: LIANG,
    cause: 'agent',
    assignment: {
      fromUserId: LIANG,
      fromTeamId: BILLING,
      toUserId: AMINA,
      toTeamId: BILLING,
    },
    reason: 'Going off shift and Amina has the refund history.',
  });

  it('carries the actor, the reason and the timestamp', () => {
    const entry = toHistoryEntry(reassigned, NAMES);

    expect(entry.actorLabel).toBe(content.tickets.historyBy('Liang Wei'));
    expect(entry.reason).toBe('Going off shift and Amina has the refund history.');
    expect(entry.createdAt).toBe('2026-08-10T08:45:00.000Z');
  });

  it('names both sides of the move', () => {
    const entry = toHistoryEntry(reassigned, NAMES);

    expect(entry.detail).toBe(content.tickets.historyHandedFromTo('Liang Wei', 'Amina Haddad'));
  });

  it('omits the from-half when nobody held it, rather than saying "from nobody"', () => {
    const entry = toHistoryEntry(
      event({
        type: 'assigned',
        actorUserId: PRIYA,
        assignment: { fromUserId: null, fromTeamId: null, toUserId: AMINA, toTeamId: null },
      }),
      NAMES,
    );

    expect(entry.detail).toBe(content.tickets.historyHandedTo('Amina Haddad'));
  });

  it('falls back to the team when the ticket moved between teams', () => {
    const entry = toHistoryEntry(
      event({
        type: 'assigned',
        assignment: { fromUserId: null, fromTeamId: null, toUserId: null, toTeamId: BILLING },
      }),
      NAMES,
    );

    expect(entry.detail).toBe(
      content.tickets.historyHandedTo(content.inbox.assignedToTeam('Billing')),
    );
  });

  it('reports an unresolvable name as another agent rather than leaking the id', () => {
    const entry = toHistoryEntry(
      event({ type: 'assigned', actorUserId: 'someone-not-in-this-page' }),
      NAMES,
    );

    expect(entry.actorLabel).toBe(
      content.tickets.historyBy(content.tickets.historyActorUnresolved),
    );
    expect(entry.actorLabel).not.toContain('someone-not-in-this-page');
  });
});

describe('an escalation entry', () => {
  it('names the supervisor it was addressed to', () => {
    const entry = toHistoryEntry(
      event({
        type: 'escalated',
        actorUserId: AMINA,
        cause: 'agent',
        toValue: PRIYA,
        reason: 'Customer is threatening a chargeback.',
      }),
      NAMES,
    );

    expect(entry.detail).toBe(content.tickets.historyEscalatedTo('Priya Raman'));
    expect(entry.reason).toBe('Customer is threatening a chargeback.');
    expect(entry.actorLabel).toBe(content.tickets.historyBy('Amina Haddad'));
  });

  it('reads a null recipient as "whoever is covering this ticket", not as missing', () => {
    const entry = toHistoryEntry(
      event({ type: 'escalated', actorUserId: AMINA, toValue: null, reason: 'Raising it again.' }),
      NAMES,
    );

    expect(entry.detail).toBe(content.tickets.historyEscalatedToAnyone);
  });

  it('is toned apart from an ordinary handoff, and says so in words either way', () => {
    const escalated = toHistoryEntry(
      event({ type: 'escalated', reason: 'Needs a decision.' }),
      NAMES,
    );
    const assigned = toHistoryEntry(event({ type: 'assigned' }), NAMES);

    expect(escalated.tone).toBe('warning');
    expect(assigned.tone).toBe('info');
    // Colour never carries it alone.
    expect(escalated.title).toBe(content.tickets.historyEvents.escalated);
    expect(assigned.title).toBe(content.tickets.historyEvents.assigned);
  });
});

describe('the other event types', () => {
  it('renders a status change as a value movement in the console’s own words', () => {
    const entry = toHistoryEntry(
      event({ type: 'status_changed', fromValue: 'open', toValue: 'pending' }),
      NAMES,
    );

    expect(entry.detail).toBe(
      content.tickets.historyValueChange(
        content.ticketStatuses.open,
        content.ticketStatuses.pending,
      ),
    );
  });

  it('names the system when nothing human wrote the event', () => {
    const entry = toHistoryEntry(event({ type: 'created' }), NAMES);

    expect(entry.actorLabel).toBe(content.tickets.historyByAutomation);
    expect(entry.detail).toBeNull();
    expect(entry.reason).toBeNull();
  });

  it('keeps the API’s order rather than re-sorting', () => {
    const entries = toHistoryEntries(
      [
        event({ id: 'b', type: 'escalated', createdAt: '2026-08-10T09:50:00.000Z' }),
        event({ id: 'a', type: 'assigned', createdAt: '2026-08-09T16:40:00.000Z' }),
      ],
      NAMES,
    );

    expect(entries.map((entry) => entry.id)).toEqual(['b', 'a']);
  });
});
