import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PlanLimits } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { formatSeatPrice } from '../plan-presentation';
import { PlanCard, type PlanListing } from './PlanCard';

/**
 * TAR-37's plans-view criterion at the card level: every tier shows its seat
 * allowance, its conversation allowance and the features it unlocks.
 *
 * The assertions are on the words, never on the styling. Whether a plan can be
 * chosen is `isSelectable`'s answer and it arrives from the API — so what is
 * pinned here is that the card *says why* rather than that it greys something
 * out, because a control that silently will not press is not an explanation.
 */

const LIMITS: PlanLimits = {
  seats: 10,
  conversationsPerPeriod: 2500,
  whatsappNumbers: 1,
  teams: 3,
  knowledgeDocuments: 25,
};

describe('PlanCard', () => {
  it('names the tier, its price and what it is per', () => {
    render(<PlanCard plan={plan()} />);

    expect(screen.getByRole('heading', { name: 'Starter' })).toBeInTheDocument();
    // Formatted through the same helper rather than written out: the currency
    // symbol an `en-GB` reader sees for USD is `US$`, not `$`, and a literal
    // would be pinning this test's author's assumption rather than the locale.
    expect(
      screen.getByText(formatSeatPrice({ amountMinor: 1900, currency: 'USD' }, content.locale)),
    ).toBeInTheDocument();
    expect(screen.getByText(content.billing.seatCadence.month)).toBeInTheDocument();
  });

  it('states both metered allowances', () => {
    render(<PlanCard plan={plan()} />);

    expect(screen.getByText(content.billing.allowanceSeats('10'))).toBeInTheDocument();
    expect(screen.getByText(content.billing.allowanceConversations('2,500'))).toBeInTheDocument();
  });

  /**
   * `null` is unlimited per `PlanLimitsSchema`, and it gets its own sentence
   * rather than a number — "0 seats" and "unlimited seats" are the two readings
   * a buyer must never confuse, and they are one keystroke apart in the data.
   */
  it('says unlimited rather than rendering a number for a null ceiling', () => {
    const unlimited = plan({
      entitlements: {
        features: [],
        limits: { ...LIMITS, seats: null, conversationsPerPeriod: null },
      },
    });

    render(<PlanCard plan={unlimited} />);

    expect(screen.getByText(content.billing.allowanceSeatsUnlimited)).toBeInTheDocument();
    expect(screen.getByText(content.billing.allowanceConversationsUnlimited)).toBeInTheDocument();
  });

  it('lists the features the tier unlocks, in the buyer’s words', () => {
    const withFeatures = plan({
      entitlements: { features: ['workflows', 'ai_chatbot'], limits: LIMITS },
    });

    render(<PlanCard plan={withFeatures} />);

    expect(screen.getByText(content.billing.features.workflows)).toBeInTheDocument();
    expect(screen.getByText(content.billing.features.ai_chatbot)).toBeInTheDocument();
    expect(screen.queryByText(content.billing.features.api_access)).not.toBeInTheDocument();
  });

  it('explains the essentials rather than showing an empty list', () => {
    render(<PlanCard plan={plan()} />);

    expect(screen.getByText(content.billing.noFeatures)).toBeInTheDocument();
  });

  it('marks the current plan in words, never by colour alone', () => {
    render(<PlanCard plan={plan({ isCurrent: true, isSelectable: false })} />);

    expect(screen.getByText(content.billing.currentPlanBadge)).toBeInTheDocument();
  });

  /**
   * The refusal that is easiest to ship as a dead button: a downgrade below
   * current usage. The card has to name the ceiling that blocks it.
   */
  it('says which ceiling blocks a plan it cannot offer', () => {
    const blocked = plan({ isSelectable: false, blockedBy: ['seats'] });

    render(<PlanCard plan={blocked} />);

    expect(screen.getByText(content.billing.blockedBy.seats)).toBeInTheDocument();
  });

  it('names every blocking ceiling, not just the first', () => {
    const blocked = plan({
      isSelectable: false,
      blockedBy: ['seats', 'conversationsPerPeriod'],
    });

    render(<PlanCard plan={blocked} />);

    expect(
      screen.getByText(
        `${content.billing.blockedBy.seats} ${content.billing.blockedBy.conversationsPerPeriod}`,
      ),
    ).toBeInTheDocument();
  });

  it('renders no control at all for a reader who may not buy', () => {
    render(<PlanCard plan={plan()} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the control it is handed', () => {
    render(<PlanCard plan={plan()} action={<button type="button">Choose Starter</button>} />);

    expect(screen.getByRole('button', { name: 'Choose Starter' })).toBeInTheDocument();
  });

  it('is a region a screen reader can move between, named by its tier', () => {
    render(<PlanCard plan={plan()} />);

    expect(screen.getByRole('article', { name: 'Starter' })).toBeInTheDocument();
  });
});

function plan(overrides: Partial<PlanListing> = {}): PlanListing {
  return {
    id: '0192f010-0000-7000-8000-000000001003',
    key: 'starter',
    name: 'Starter',
    pricePerSeat: { amountMinor: 1900, currency: 'USD' },
    interval: 'month',
    isPublic: true,
    entitlements: { features: [], limits: LIMITS },
    isCurrent: false,
    isSelectable: true,
    blockedBy: [],
    ...overrides,
  };
}
