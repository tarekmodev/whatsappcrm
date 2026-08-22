import { describe, expect, it } from 'vitest';
import type { BillingSummaryResponse, Plan, PlanLimits } from '@whatsappcrm/contracts';
import {
  formatCount,
  formatSeatPrice,
  readPlanUsage,
  readVolumeBanner,
  reportCheckout,
} from './plan-presentation';

const LOCALE = 'en-GB';

describe('formatSeatPrice', () => {
  it('renders a two-digit currency from its minor units', () => {
    expect(formatSeatPrice({ amountMinor: 1900, currency: 'USD' }, LOCALE)).toContain('19.00');
  });

  /**
   * The bug this guards is a wrong invoice, not a wrong glyph. This product is
   * sold into the GCC, where KWD carries **three** minor digits: dividing by a
   * hard-coded 100 would price a 19.000 KWD plan at 190.00.
   */
  it('uses the currency’s own minor-unit exponent, not a hard-coded 100', () => {
    expect(formatSeatPrice({ amountMinor: 19_000, currency: 'KWD' }, LOCALE)).toContain('19.000');
  });

  it('renders a zero-digit currency with no fraction at all', () => {
    expect(formatSeatPrice({ amountMinor: 1900, currency: 'JPY' }, LOCALE)).toContain('1,900');
  });

  it('renders a free tier as zero rather than as nothing', () => {
    expect(formatSeatPrice({ amountMinor: 0, currency: 'USD' }, LOCALE)).toContain('0.00');
  });
});

describe('readPlanUsage', () => {
  it('counts pending invitations against the seat cap', () => {
    // ADR 0009: a seat is held the moment it is offered. A meter that showed
    // only accepted members would contradict the refusal the admin then gets.
    const readings = readPlanUsage(usage({ seatsUsed: 4, seatsPending: 1 }), limits({ seats: 6 }));

    expect(readings.seats.used).toBe(5);
    expect(readings.seats.isAtCap).toBe(false);
  });

  it('treats a null ceiling as unlimited rather than as zero', () => {
    const readings = readPlanUsage(usage({ seatsUsed: 40 }), limits({ seats: null }));

    expect(readings.seats.ratio).toBeUndefined();
    expect(readings.seats.isAtCap).toBe(false);
  });

  it('keeps a count that has overshot its cap at cap rather than flipping back', () => {
    // A plan downgraded below current usage is a real state.
    const readings = readPlanUsage(usage({ seatsUsed: 9 }), limits({ seats: 3 }));

    expect(readings.seats.isAtCap).toBe(true);
    expect(readings.seats.tone).toBe('danger');
  });
});

describe('readVolumeBanner', () => {
  it('says nothing well below the allowance', () => {
    expect(volumeBannerAt(100, 1000)).toBeNull();
  });

  it('warns before the cap, not at it — the point is to be seen in time', () => {
    expect(volumeBannerAt(800, 1000)).toBe('approaching');
  });

  it('escalates once the allowance is gone', () => {
    expect(volumeBannerAt(1000, 1000)).toBe('reached');
  });

  it('says nothing at all on an unlimited plan', () => {
    expect(volumeBannerAt(9_999, null)).toBeNull();
  });
});

describe('reportCheckout', () => {
  it('says nothing when the page was not reached from a checkout', () => {
    expect(reportCheckout(undefined, undefined, summary())).toBeNull();
  });

  it('reports a cancellation without looking at the subscription at all', () => {
    expect(reportCheckout('cancelled', undefined, summary())).toEqual({ kind: 'cancelled' });
  });

  /**
   * The rule the whole flow turns on: the provider's redirect routinely beats
   * its own webhook, so a browser that is back is not evidence that a payment
   * has been applied.
   */
  it('does not claim success while the subscription is still the old one', () => {
    expect(reportCheckout('succeeded', 'growth', summary())).toEqual({ kind: 'confirming' });
  });

  it('confirms only when the subscription is active AND on the plan bought', () => {
    const report = reportCheckout('succeeded', 'growth', summary({ planKey: 'growth' }));

    expect(report).toEqual({ kind: 'succeeded', planName: 'Growth' });
  });

  /**
   * Without the plan check, an upgrade between two paid tiers would report
   * success against the tier the tenant was already on — the failure mode this
   * parameter exists to stop.
   */
  it('does not mistake an existing paid plan for the upgrade just bought', () => {
    const report = reportCheckout('succeeded', 'scale', summary({ planKey: 'growth' }));

    expect(report).toEqual({ kind: 'confirming' });
  });

  it('falls back to "is there an active subscription" when the link names no plan', () => {
    expect(reportCheckout('succeeded', undefined, summary({ planKey: 'growth' }))).toEqual({
      kind: 'succeeded',
      planName: 'Growth',
    });
  });

  it('stays in confirming while the subscription is still incomplete', () => {
    const pending = summary({ planKey: 'growth', status: 'incomplete' });

    expect(reportCheckout('succeeded', 'growth', pending)).toEqual({ kind: 'confirming' });
  });
});

describe('formatCount', () => {
  it('formats against the content module’s locale, not the runtime’s', () => {
    // A runtime-locale formatter renders one string on the server and another in
    // the browser, which is a hydration mismatch rather than a nicety.
    expect(formatCount(10_000, LOCALE)).toBe('10,000');
  });
});

function volumeBannerAt(used: number, cap: number | null): 'approaching' | 'reached' | null {
  return readVolumeBanner(
    readPlanUsage(
      usage({ conversationsThisPeriod: used }),
      limits({ conversationsPerPeriod: cap }),
    ),
  );
}

function usage(
  overrides: Partial<BillingSummaryResponse['usage']> = {},
): BillingSummaryResponse['usage'] {
  return { seatsUsed: 0, seatsPending: 0, conversationsThisPeriod: 0, ...overrides };
}

function limits(overrides: Partial<PlanLimits> = {}): PlanLimits {
  return {
    seats: 10,
    conversationsPerPeriod: 1000,
    whatsappNumbers: 1,
    teams: 2,
    knowledgeDocuments: 10,
    ...overrides,
  };
}

function plan(key: string, name: string): Plan {
  return {
    id: '0192f010-0000-7000-8000-000000001004',
    key,
    name,
    pricePerSeat: { amountMinor: 3900, currency: 'USD' },
    interval: 'month',
    isPublic: true,
    entitlements: { features: [], limits: limits() },
  };
}

/** A summary with no subscription by default — the state a trialing tenant is in. */
function summary({
  planKey,
  status = 'active',
}: {
  planKey?: string;
  status?: NonNullable<BillingSummaryResponse['subscription']>['status'];
} = {}): BillingSummaryResponse {
  if (planKey === undefined) {
    return {
      subscription: null,
      plan: null,
      entitlements: { features: [], limits: limits() },
      usage: usage(),
      cancelsAt: null,
    };
  }

  return {
    subscription: {
      id: '0192f011-0000-7000-8000-000000001101',
      tenantId: '0192f000-0000-7000-8000-00000000a001',
      planKey,
      status,
      seats: 5,
      currentPeriodStart: '2026-08-01T00:00:00.000Z',
      currentPeriodEnd: '2026-09-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      trialEndsAt: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    plan: plan(planKey, planKey === 'growth' ? 'Growth' : 'Scale'),
    entitlements: { features: [], limits: limits() },
    usage: usage(),
    cancelsAt: null,
  };
}
