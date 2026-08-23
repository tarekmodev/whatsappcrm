import { describe, expect, it } from 'vitest';
import { ASSIGNMENT_POLICY } from '@whatsappcrm/contracts';
import {
  draftForRow,
  effectiveTicketLimit,
  resolveTicketLimit,
  withLimit,
  withUsesDefault,
} from './capacity-input';
import type { AgentCapacityRow } from './capacity';

/**
 * What the cap form will send. The bounds are the contract's, so these assert
 * that the form *reads* them rather than restating numbers of its own — the
 * failure being guarded is a console that accepts a value the database will
 * reject, or refuses one it would have taken.
 */

function row(own: number | null, effective: number): AgentCapacityRow {
  return {
    user: {
      id: 'a',
      email: 'a@northwind.example',
      displayName: 'Aisha',
      avatarUrl: null,
      role: 'agent',
      status: 'active',
      availability: 'available',
      teamIds: [],
      occupiesSeat: true,
      lastSeenAt: null,
      security: null,
      assignmentCapacity: {
        maxConcurrentTickets: own,
        effectiveMaxConcurrentTickets: effective,
        activeTicketCount: 0,
      },
      createdAt: '2026-07-02T10:00:00.000Z',
    },
    capacity: {
      maxConcurrentTickets: own,
      effectiveMaxConcurrentTickets: effective,
      activeTicketCount: 0,
    },
    isAtCapacity: false,
  };
}

describe('draftForRow', () => {
  it('opens on the agent’s own limit when they have one', () => {
    expect(draftForRow(row(2, 2))).toEqual({ usesDefault: false, limit: '2' });
  });

  it('opens on "inherit" when they have none, showing the value they inherit', () => {
    expect(draftForRow(row(null, 5))).toEqual({ usesDefault: true, limit: '5' });
  });
});

describe('resolveTicketLimit', () => {
  it('sends null to clear the override, which is not the same as sending nothing', () => {
    expect(resolveTicketLimit({ usesDefault: true, limit: '9' })).toEqual({
      status: 'valid',
      maxConcurrentTickets: null,
    });
  });

  it('accepts the bounds the contract publishes', () => {
    for (const value of [
      ASSIGNMENT_POLICY.minMaxConcurrentTickets,
      ASSIGNMENT_POLICY.maxMaxConcurrentTickets,
    ]) {
      expect(resolveTicketLimit({ usesDefault: false, limit: String(value) })).toEqual({
        status: 'valid',
        maxConcurrentTickets: value,
      });
    }
  });

  it('refuses anything outside them, and anything that is not a whole number', () => {
    const rejected = [
      String(ASSIGNMENT_POLICY.minMaxConcurrentTickets - 1),
      String(ASSIGNMENT_POLICY.maxMaxConcurrentTickets + 1),
      '-3',
      '2.5',
      '',
      '   ',
      // `parseInt` would read this as 3 and send a number nobody typed.
      '3 tickets',
    ];

    for (const limit of rejected) {
      expect(resolveTicketLimit({ usesDefault: false, limit })).toEqual({ status: 'invalid' });
    }
  });

  it('ignores surrounding whitespace rather than refusing over it', () => {
    expect(resolveTicketLimit({ usesDefault: false, limit: ' 7 ' })).toEqual({
      status: 'valid',
      maxConcurrentTickets: 7,
    });
  });
});

/**
 * The invariant behind "nothing is ever both" (TAR-778): the checkbox and the
 * number field are two views of one decision, so the transitions between them
 * live here rather than in the component that renders them.
 */
describe('withUsesDefault', () => {
  it('rewrites the number to the default it is about to inherit', () => {
    expect(withUsesDefault({ usesDefault: false, limit: '9' }, true, 5)).toEqual({
      usesDefault: true,
      limit: '5',
    });
  });

  /** Clearing it leaves a number to edit rather than blanking a field just read. */
  it('keeps the number in place when the box comes off', () => {
    expect(withUsesDefault({ usesDefault: true, limit: '5' }, false, 5)).toEqual({
      usesDefault: false,
      limit: '5',
    });
  });
});

describe('withLimit', () => {
  it('takes the box off, so a typed number and an inherited one cannot both hold', () => {
    expect(withLimit('7')).toEqual({ usesDefault: false, limit: '7' });
  });
});

/**
 * What rotation would compare against, which is not what the form sends: `null`
 * on the wire means "clear the override", and the number that then applies is the
 * workspace default. One rule, so the below-load warning cannot fire for a typed
 * value and stay silent for the identical inherited one.
 */
describe('effectiveTicketLimit', () => {
  it('resolves a cleared override to the workspace default', () => {
    expect(effectiveTicketLimit({ usesDefault: true, limit: '' }, 5)).toBe(5);
  });

  it('resolves a typed value to itself', () => {
    expect(effectiveTicketLimit({ usesDefault: false, limit: '9' }, 5)).toBe(9);
  });

  it('has no answer while the typed value is not a limit', () => {
    expect(effectiveTicketLimit({ usesDefault: false, limit: '0' }, 5)).toBeNull();
    expect(effectiveTicketLimit({ usesDefault: false, limit: '' }, 5)).toBeNull();
  });
});
