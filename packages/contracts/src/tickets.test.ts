import { describe, expect, it } from 'vitest';
import {
  TICKET_STATUSES,
  TICKET_STATUS_REQUIRES_CLOSE,
  TICKET_STATUS_TRANSITIONS,
  TicketUpdateInputSchema,
  canAgentTransition,
} from './tickets';

/**
 * ADR 0006 §2's transition table, published rather than re-typed. The console
 * builds its controls from these and the API refuses the same moves with them,
 * so the properties worth pinning are the ones a second copy would break.
 */

describe('TICKET_STATUS_TRANSITIONS', () => {
  it('refuses every move out of a terminal status except resolved → closed', () => {
    // There is no reopen window at v1 (ADR 0003 open question 1), and the
    // partial unique index would refuse a re-activation anyway.
    expect(TICKET_STATUS_TRANSITIONS.resolved).toEqual(['closed']);
    expect(TICKET_STATUS_TRANSITIONS.closed).toEqual([]);
  });

  it('allows open → closed without passing through resolved', () => {
    // Closing spam or a wrong number is not a resolution, and forcing the
    // two-step would put a fake resolution time on every one of them.
    expect(TICKET_STATUS_TRANSITIONS.open).toContain('closed');
  });

  it('never lists a status as a transition out of itself', () => {
    // Same-value is the no-op below, not an entry in the table — a table that
    // listed it would make every control offer a button that does nothing.
    for (const status of TICKET_STATUSES) {
      expect(TICKET_STATUS_TRANSITIONS[status]).not.toContain(status);
    }
  });
});

describe('canAgentTransition', () => {
  it('does not treat setting the value it already has as a transition', () => {
    // The no-op of ADR 0006 §2 is the *endpoint's* behaviour, not this
    // predicate's: a caller filters equality out first and never reaches here,
    // so `from === to` is simply not a move. Both this and the console's mock
    // transport check the values differ before asking.
    for (const status of TICKET_STATUSES) {
      expect(canAgentTransition(status, status)).toBe(false);
    }
  });

  it('refuses re-activating a resolved or closed ticket', () => {
    expect(canAgentTransition('resolved', 'open')).toBe(false);
    expect(canAgentTransition('resolved', 'pending')).toBe(false);
    expect(canAgentTransition('closed', 'open')).toBe(false);
    expect(canAgentTransition('closed', 'resolved')).toBe(false);
  });

  it('agrees with the table for every pair', () => {
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        expect(canAgentTransition(from, to)).toBe(TICKET_STATUS_TRANSITIONS[from].includes(to));
      }
    }
  });
});

describe('TICKET_STATUS_REQUIRES_CLOSE', () => {
  it('gates exactly the two statuses that cannot be undone', () => {
    expect(TICKET_STATUS_REQUIRES_CLOSE).toEqual({
      open: false,
      pending: false,
      resolved: true,
      closed: true,
    });
  });
});

describe('TicketUpdateInputSchema', () => {
  it('refuses a body with nothing in it', () => {
    // `{}` is a client bug with no honest answer, so it is `validation_failed`
    // rather than a no-op 200 — enforced here so no route has to remember.
    expect(TicketUpdateInputSchema.safeParse({}).success).toBe(false);
  });

  it('accepts any one field on its own', () => {
    expect(TicketUpdateInputSchema.safeParse({ status: 'resolved' }).success).toBe(true);
    expect(TicketUpdateInputSchema.safeParse({ priority: 'urgent' }).success).toBe(true);
    expect(TicketUpdateInputSchema.safeParse({ subject: 'Refund' }).success).toBe(true);
  });

  it('refuses a status or priority outside the published unions', () => {
    expect(TicketUpdateInputSchema.safeParse({ status: 'archived' }).success).toBe(false);
    expect(TicketUpdateInputSchema.safeParse({ priority: 'critical' }).success).toBe(false);
  });
});
