import { describe, expect, it } from 'vitest';
import { content } from '@/content/en';
import {
  assigneeLabelFor,
  isStatusFinal,
  isTerminalStatus,
  statusMovesFor,
  ticketLabel,
} from './presentation';

/**
 * The mapping layer the queue row, the ticket header and the status controls all
 * read. Tested here rather than through three components, because the point of
 * it existing is that all three cannot answer differently.
 */

const USER_ID = '0192f001-0000-7000-8000-000000000101';
const TEAM_ID = '0192f002-0000-7000-8000-000000000201';

describe('statusMovesFor', () => {
  it('offers every transition the contract allows to a principal who may close', () => {
    expect(statusMovesFor('open', true)).toEqual(['pending', 'resolved', 'closed']);
    expect(statusMovesFor('pending', true)).toEqual(['open', 'resolved', 'closed']);
    expect(statusMovesFor('resolved', true)).toEqual(['closed']);
  });

  it('omits the terminal pair without ticket:close rather than disabling it', () => {
    // A disabled control explains nothing from the other side of a support call
    // and is skipped by keyboard navigation; the panel says why instead.
    expect(statusMovesFor('open', false)).toEqual(['pending']);
    expect(statusMovesFor('pending', false)).toEqual(['open']);
    expect(statusMovesFor('resolved', false)).toEqual([]);
  });

  it('offers nothing out of closed, whatever the principal holds', () => {
    expect(statusMovesFor('closed', true)).toEqual([]);
    expect(statusMovesFor('closed', false)).toEqual([]);
  });
});

describe('isTerminalStatus / isStatusFinal', () => {
  it('treats resolved and closed as the one-way pair', () => {
    expect(isTerminalStatus('resolved')).toBe(true);
    expect(isTerminalStatus('closed')).toBe(true);
    expect(isTerminalStatus('open')).toBe(false);
    expect(isTerminalStatus('pending')).toBe(false);
  });

  it('calls only closed final — resolved can still be closed', () => {
    expect(isStatusFinal('closed')).toBe(true);
    expect(isStatusFinal('resolved')).toBe(false);
  });
});

describe('ticketLabel', () => {
  it('uses the subject when the ticket has one', () => {
    expect(ticketLabel({ subject: 'July invoice', number: 1042 })).toBe('July invoice');
  });

  it('falls back to the number, which is what an auto-created ticket has', () => {
    expect(ticketLabel({ subject: null, number: 1042 })).toBe(content.tickets.untitled(1042));
  });
});

describe('assigneeLabelFor', () => {
  const names = new Map([[USER_ID, 'Amina Haddad']]);
  const teams = new Map([[TEAM_ID, 'Billing']]);

  it('names the person holding it', () => {
    expect(
      assigneeLabelFor({ assignedUserId: USER_ID, assignedTeamId: TEAM_ID }, names, teams),
    ).toBe('Amina Haddad');
  });

  it('falls back to the team when nobody holds it personally', () => {
    expect(assigneeLabelFor({ assignedUserId: null, assignedTeamId: TEAM_ID }, names, teams)).toBe(
      content.inbox.assignedToTeam('Billing'),
    );
  });

  it('still reports "assigned" for a holder the directory could not resolve', () => {
    // Showing a held ticket as free would send somebody to work already being
    // done — the directory read is one page, so this is reachable.
    expect(
      assigneeLabelFor({ assignedUserId: 'unknown-id', assignedTeamId: null }, names, teams),
    ).toBe(content.inbox.assignedToUnresolved);
  });

  it('reports unassigned only when it genuinely is', () => {
    expect(assigneeLabelFor({ assignedUserId: null, assignedTeamId: null }, names, teams)).toBe(
      content.common.unassigned,
    );
  });
});
