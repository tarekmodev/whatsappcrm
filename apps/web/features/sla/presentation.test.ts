import { describe, expect, it } from 'vitest';
import type { TicketSla } from '@whatsappcrm/contracts';
import {
  firstResponseIndicator,
  resolutionIndicator,
  ticketRowTone,
  SLA_STATE_TONES,
} from './presentation';

/**
 * The mapping ADR 0006 §8.3 fixes, and the two rules that hang off it: nothing
 * is shown for a ticket with no SLA, and a breach is the only thing that flags a
 * row.
 */

const DUE_AT = '2026-08-09T15:05:00.000Z';

function sla(overrides: Partial<TicketSla> = {}): TicketSla {
  return {
    policyId: '0192f00b-0000-7000-8000-000000000b01',
    firstResponseState: 'running',
    firstResponseDueAt: DUE_AT,
    resolutionState: 'not_applicable',
    resolutionDueAt: null,
    ...overrides,
  };
}

describe('firstResponseIndicator', () => {
  it('maps each observable state onto its tone and its deadline', () => {
    for (const state of ['running', 'paused', 'met', 'breached'] as const) {
      const indicator = firstResponseIndicator(sla({ firstResponseState: state }));

      expect(indicator).not.toBeNull();
      expect(indicator?.state).toBe(state);
      expect(indicator?.tone).toBe(SLA_STATE_TONES[state]);
      expect(indicator?.dueAt).toBe(DUE_AT);
    }
  });

  it('shows nothing for a tenant with no SLA policy', () => {
    expect(
      firstResponseIndicator(
        sla({ firstResponseState: 'not_applicable', firstResponseDueAt: null }),
      ),
    ).toBeNull();
  });

  it('shows nothing rather than a badge with no deadline behind it', () => {
    // The contract allows the pair; a component that rendered a countdown to
    // `null` would print "Invalid Date".
    expect(firstResponseIndicator(sla({ firstResponseDueAt: null }))).toBeNull();
  });

  it('only counts down while the timer is running', () => {
    expect(firstResponseIndicator(sla({ firstResponseState: 'running' }))?.isCounting).toBe(true);
    expect(firstResponseIndicator(sla({ firstResponseState: 'paused' }))?.isCounting).toBe(false);
    expect(firstResponseIndicator(sla({ firstResponseState: 'breached' }))?.isCounting).toBe(false);
  });

  it('labels every state in words, so colour is never the only signal', () => {
    for (const state of ['running', 'paused', 'met', 'breached'] as const) {
      expect(firstResponseIndicator(sla({ firstResponseState: state }))?.label).toMatch(/\S/);
    }
  });
});

describe('resolutionIndicator', () => {
  it('reads the resolution pair, not the first-response one', () => {
    const indicator = resolutionIndicator(
      sla({
        firstResponseState: 'breached',
        resolutionState: 'running',
        resolutionDueAt: '2026-08-12T09:00:00.000Z',
      }),
    );

    expect(indicator?.state).toBe('running');
    expect(indicator?.dueAt).toBe('2026-08-12T09:00:00.000Z');
  });

  it('is null on the seeded policy, which leaves `resolutionMinutes` unset', () => {
    expect(resolutionIndicator(sla())).toBeNull();
  });
});

describe('ticketRowTone', () => {
  it('flags a breached first response', () => {
    expect(ticketRowTone(sla({ firstResponseState: 'breached' }))).toBe('danger');
  });

  it('flags a breached resolution even when the first response was met', () => {
    expect(
      ticketRowTone(
        sla({
          firstResponseState: 'met',
          resolutionState: 'breached',
          resolutionDueAt: DUE_AT,
        }),
      ),
    ).toBe('danger');
  });

  it('leaves every other row unflagged, so the flag still means something', () => {
    for (const state of ['not_applicable', 'running', 'paused', 'met'] as const) {
      expect(ticketRowTone(sla({ firstResponseState: state }))).toBeUndefined();
    }
  });
});
