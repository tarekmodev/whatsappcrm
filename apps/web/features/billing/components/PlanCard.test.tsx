import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { PlanLimits } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { content } from '@/content/en';
import { planCardIds } from '../constants';
import { formatSeatPrice } from '../plan-presentation';
import { PlanCard, type PlanListing } from './PlanCard';

/**
 * TAR-37's plans-view criterion at the card level — every tier shows its seat
 * allowance, its conversation allowance and the features it unlocks — plus
 * TAR-711's, which is that all five tiers say it in the **same shape**.
 *
 * The assertions are on the words and the structure, never on the styling.
 * Whether a plan can be chosen is `isSelectable`'s answer and it arrives from
 * the API — so what is pinned here is that the card *says why*, next to the
 * control it is about and programmatically tied to it, because a control that
 * silently will not press is not an explanation.
 */

const LIMITS: PlanLimits = {
  seats: 10,
  conversationsPerPeriod: 2500,
  whatsappNumbers: 1,
  teams: 3,
  knowledgeDocuments: 25,
};

/** A card is an item in the plans list, so it is rendered in one. */
function renderCard(ui: React.ReactNode) {
  return render(<ul>{ui}</ul>);
}

describe('PlanCard', () => {
  it('names the tier, its price and what it is per', () => {
    renderCard(<PlanCard plan={plan()} />);

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
    renderCard(<PlanCard plan={plan()} />);

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

    renderCard(<PlanCard plan={unlimited} />);

    expect(screen.getByText(content.billing.allowanceSeatsUnlimited)).toBeInTheDocument();
    expect(screen.getByText(content.billing.allowanceConversationsUnlimited)).toBeInTheDocument();
  });

  it('lists the features the tier unlocks, in the buyer’s words', () => {
    const withFeatures = plan({
      entitlements: { features: ['workflows', 'ai_chatbot'], limits: LIMITS },
    });

    renderCard(<PlanCard plan={withFeatures} />);

    expect(screen.getByText(content.billing.features.workflows)).toBeInTheDocument();
    expect(screen.getByText(content.billing.features.ai_chatbot)).toBeInTheDocument();
    expect(screen.queryByText(content.billing.features.api_access)).not.toBeInTheDocument();
  });

  /**
   * TAR-711's card-anatomy criterion, and the one a screenshot catches faster
   * than a test: four tiers listed what they included as bullets while one
   * substituted a sentence, so the block a buyer was scanning down changed shape
   * halfway across the row.
   *
   * Both blocks are lists on every tier — including one with nothing extra to
   * list, which shows a shorter list rather than a different kind of block.
   */
  it('says both allowances and includes as lists, on every tier', () => {
    const { rerender } = renderCard(
      <PlanCard plan={plan({ entitlements: { features: ['workflows'], limits: LIMITS } })} />,
    );

    expect(bulletsUnder(content.billing.allowancesHeading)).toHaveLength(2);
    expect(bulletsUnder(content.billing.featuresHeading)).toHaveLength(1);

    // A tier with nothing extra to list gets a shorter list, not a sentence.
    rerender(
      <ul>
        <PlanCard plan={plan()} />
      </ul>,
    );

    const includes = bulletsUnder(content.billing.featuresHeading);
    expect(includes).toHaveLength(1);
    expect(includes[0]).toHaveTextContent(content.billing.noFeatures);
  });

  it('marks the current plan in words, never by colour alone', () => {
    renderCard(<PlanCard plan={plan({ isCurrent: true, isSelectable: false })} />);

    expect(screen.getByText(content.billing.currentPlanBadge)).toBeInTheDocument();
  });

  /**
   * The refusal that is easiest to ship as a dead button: a downgrade below
   * current usage. The card has to name the ceiling that blocks it, beside the
   * control rather than floating above the plan.
   */
  it('says which ceiling blocks a plan it cannot offer', () => {
    const blocked = plan({ isSelectable: false, blockedBy: ['seats'] });

    renderCard(<PlanCard plan={blocked} action={<button type="button">Choose Starter</button>} />);

    expect(screen.getByText(content.billing.blockedBy.seats)).toBeInTheDocument();
  });

  it('names every blocking ceiling, not just the first', () => {
    const blocked = plan({
      isSelectable: false,
      blockedBy: ['seats', 'conversationsPerPeriod'],
    });

    renderCard(<PlanCard plan={blocked} action={<button type="button">Choose Starter</button>} />);

    expect(
      screen.getByText(
        `${content.billing.blockedBy.seats} ${content.billing.blockedBy.conversationsPerPeriod}`,
      ),
    ).toBeInTheDocument();
  });

  /**
   * TAR-711: the reason has to reach the reader who cannot see it sitting under
   * the button. `aria-disabled` rather than the native attribute is what keeps
   * the control focusable so the description is announced at all.
   */
  it('ties the reason to the control, so an unavailable plan explains itself', () => {
    const blocked = plan({ isSelectable: false, blockedBy: ['seats'] });

    renderCard(
      <PlanCard
        plan={blocked}
        action={
          <Button isUnavailable aria-describedby={planCardIds(blocked.key).blocked}>
            {content.billing.choosePlan(blocked.name)}
          </Button>
        }
      />,
    );

    const control = screen.getByRole('button', {
      name: content.billing.choosePlan('Starter'),
      description: content.billing.blockedBy.seats,
    });

    expect(control).toHaveAttribute('aria-disabled', 'true');
  });

  it('renders no control at all for a reader who may not buy', () => {
    renderCard(<PlanCard plan={plan()} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the control it is handed', () => {
    renderCard(<PlanCard plan={plan()} action={<button type="button">Choose Starter</button>} />);

    expect(screen.getByRole('button', { name: 'Choose Starter' })).toBeInTheDocument();
  });

  /**
   * The card is an item in a list of priced options, and the price is half of
   * what tells two of them apart — a name alone leaves a screen-reader user
   * comparing five identical-sounding entries.
   */
  it('is a list item named by its tier and its price', () => {
    renderCard(<PlanCard plan={plan()} />);

    const price = formatSeatPrice({ amountMinor: 1900, currency: 'USD' }, content.locale);

    expect(
      screen.getByRole('listitem', {
        name: `Starter ${price} ${content.billing.seatCadence.month}`,
      }),
    ).toBeInTheDocument();
  });
});

/** The items of one of the card's two bullet blocks, found by its heading. */
function bulletsUnder(heading: string): readonly HTMLElement[] {
  return within(screen.getByRole('list', { name: heading })).getAllByRole('listitem');
}

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
