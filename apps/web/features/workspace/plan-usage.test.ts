import { describe, expect, it } from 'vitest';
import type { PlanLimits, TenantLifecycleResponse } from '@whatsappcrm/contracts';
import { readConversationUsage, readSeatUsage } from './plan-usage';

/**
 * The rules the seat and conversation meters rest on. Worth testing away from
 * the components, because the two that are easy to get wrong are invisible in
 * the rendered output: that an unlimited plan is not a plan at zero, and that
 * pending invitations count against the cap.
 */

const LIMITS: PlanLimits = {
  seats: 5,
  conversationsPerPeriod: 1000,
  whatsappNumbers: 1,
  teams: 2,
  knowledgeDocuments: 10,
};

function lifecycle(
  usage: Partial<TenantLifecycleResponse['usage']>,
  limits: Partial<PlanLimits> = {},
): TenantLifecycleResponse {
  return {
    status: 'trialing',
    trialEndsAt: null,
    gracePeriodEndsAt: null,
    purgeAt: null,
    plan: {
      key: 'trial',
      name: 'Trial',
      entitlements: { features: [], limits: { ...LIMITS, ...limits } },
    },
    usage: { seatsUsed: 0, seatsPending: 0, conversationsThisPeriod: 0, ...usage },
  };
}

describe('seat usage', () => {
  it('counts pending invitations against the cap alongside active agents', () => {
    const reading = readSeatUsage(lifecycle({ seatsUsed: 4, seatsPending: 1 }));

    expect(reading.used).toBe(5);
    expect(reading.cap).toBe(5);
    expect(reading.isAtCap).toBe(true);
  });

  it('warns before the cap rather than only at it', () => {
    expect(readSeatUsage(lifecycle({ seatsUsed: 3 })).tone).toBe('accent');
    expect(readSeatUsage(lifecycle({ seatsUsed: 4 })).tone).toBe('warning');
    expect(readSeatUsage(lifecycle({ seatsUsed: 5 })).tone).toBe('danger');
  });

  /**
   * A plan downgraded below its current usage. The count stays over the cap and
   * the reading stays at-cap — flipping `isAtCap` back to false above the line
   * would let the console offer an invitation the API refuses.
   */
  it('stays at cap when usage has overshot it', () => {
    const reading = readSeatUsage(lifecycle({ seatsUsed: 8 }));

    expect(reading.isAtCap).toBe(true);
    expect(reading.ratio).toBeGreaterThan(1);
    expect(reading.tone).toBe('danger');
  });

  it('treats a null limit as unlimited, not as zero', () => {
    const reading = readSeatUsage(lifecycle({ seatsUsed: 40 }, { seats: null }));

    expect(reading.cap).toBeNull();
    expect(reading.ratio).toBeUndefined();
    expect(reading.isAtCap).toBe(false);
    expect(reading.tone).toBe('accent');
  });

  it('treats a zero limit as none available, not as unlimited', () => {
    const reading = readSeatUsage(lifecycle({ seatsUsed: 0 }, { seats: 0 }));

    expect(reading.isAtCap).toBe(true);
    expect(reading.ratio).toBe(1);
  });
});

describe('conversation usage', () => {
  it('reads the period counter against the plan’s conversation cap', () => {
    const reading = readConversationUsage(lifecycle({ conversationsThisPeriod: 250 }));

    expect(reading.used).toBe(250);
    expect(reading.cap).toBe(1000);
    expect(reading.ratio).toBeCloseTo(0.25);
    expect(reading.isAtCap).toBe(false);
  });

  it('ignores the seat cap entirely', () => {
    const reading = readConversationUsage(
      lifecycle({ seatsUsed: 5, conversationsThisPeriod: 10 }, { seats: 1 }),
    );

    expect(reading.used).toBe(10);
    expect(reading.cap).toBe(1000);
  });
});
