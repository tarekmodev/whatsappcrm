import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BillingSummaryResponse, PlanLimits } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { readPlanUsage } from '../plan-presentation';
import { CancellationBanner } from './CancellationBanner';
import { CheckoutOutcomeBanner } from './CheckoutOutcomeBanner';
import { VolumeThresholdBanner } from './VolumeThresholdBanner';

/**
 * The three banners on the billing surface, and the promises each one must not
 * break.
 *
 * All three are about **not overclaiming**. A cancellation that has been asked
 * for is not a workspace that has closed; a volume allowance that has run out
 * has not blocked anybody's replies; and a browser that is back from a hosted
 * checkout is not a payment the API has confirmed. Each of those is a sentence
 * that would be false on the day it mattered most.
 */

const LIMITS: PlanLimits = {
  seats: 10,
  conversationsPerPeriod: 1000,
  whatsappNumbers: 1,
  teams: 3,
  knowledgeDocuments: 25,
};

describe('VolumeThresholdBanner', () => {
  it('stays out of the way well below the allowance', () => {
    const { container } = render(<VolumeThresholdBanner readings={readingsAt(100)} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('warns before the allowance runs out, which is the point of warning', () => {
    render(<VolumeThresholdBanner readings={readingsAt(850)} />);

    expect(screen.getByText(content.billing.volumeBanner.approachingHeading)).toBeInTheDocument();
  });

  /**
   * The default volume policy is `warn`, and inbound is never refused under
   * either policy. A banner that said replies were blocked would be false on a
   * `warn` deployment — and frightening in exactly the way that generates a
   * support call.
   */
  it('never claims anything was blocked once the allowance is gone', () => {
    render(<VolumeThresholdBanner readings={readingsAt(1000)} />);

    expect(screen.getByText(content.billing.volumeBanner.reachedHeading)).toBeInTheDocument();
    expect(
      screen.getByText(content.billing.volumeBanner.reachedBody('1,000', '1,000')),
    ).toBeInTheDocument();
  });

  it('offers the way out only where the way out is somewhere else', () => {
    const { rerender } = render(<VolumeThresholdBanner readings={readingsAt(1000)} />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    rerender(<VolumeThresholdBanner readings={readingsAt(1000)} withAction />);

    expect(
      screen.getByRole('link', { name: content.billing.volumeBanner.action }),
    ).toBeInTheDocument();
  });

  it('says nothing at all on an unlimited plan', () => {
    const readings = readPlanUsage(usage(9_999), { ...LIMITS, conversationsPerPeriod: null });
    const { container } = render(<VolumeThresholdBanner readings={readings} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe('CancellationBanner', () => {
  it('says nothing when no cancellation has been requested', () => {
    const { container } = render(<CancellationBanner cancelsAt={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  /**
   * `cancelsAt` being set does **not** mean the workspace is cancelled: the
   * provider reports a cancellation the moment it is requested, and the tenant
   * has paid through the period. Copy that read "your workspace is closed" would
   * contradict the API on the day somebody clicked cancel.
   */
  it('says everything still works until the date', () => {
    render(<CancellationBanner cancelsAt="2026-09-01T00:00:00.000Z" />);

    expect(screen.getByText(content.billing.cancellationBanner.heading)).toBeInTheDocument();
    expect(screen.getByText(content.billing.cancellationBanner.body)).toBeInTheDocument();
    expect(screen.getByText(content.billing.cancellationBanner.dateLabel)).toBeInTheDocument();
  });
});

describe('CheckoutOutcomeBanner', () => {
  it('says nothing when the page was not reached from a checkout', () => {
    const { container } = render(<CheckoutOutcomeBanner report={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('confirms the plan by name once the API agrees it is active', () => {
    render(<CheckoutOutcomeBanner report={{ kind: 'succeeded', planName: 'Growth' }} />);

    expect(screen.getByText(content.billing.outcome.succeededBody('Growth'))).toBeInTheDocument();
  });

  /**
   * The state the whole flow turns on. The provider's redirect routinely beats
   * its own webhook, so this is the true sentence for the first few seconds —
   * and the honest thing to offer with it is a way to look again.
   */
  it('admits it is still waiting rather than announcing a payment it cannot see', () => {
    render(<CheckoutOutcomeBanner report={{ kind: 'confirming' }} />);

    expect(screen.getByText(content.billing.outcome.confirmingHeading)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: content.billing.outcome.confirmingAction }),
    ).toBeInTheDocument();
  });

  it('says plainly that nothing was charged when the user backed out', () => {
    render(<CheckoutOutcomeBanner report={{ kind: 'cancelled' }} />);

    expect(screen.getByText(content.billing.outcome.cancelledBody)).toBeInTheDocument();
  });
});

function readingsAt(conversations: number) {
  return readPlanUsage(usage(conversations), LIMITS);
}

function usage(conversationsThisPeriod: number): BillingSummaryResponse['usage'] {
  return { seatsUsed: 2, seatsPending: 0, conversationsThisPeriod };
}
