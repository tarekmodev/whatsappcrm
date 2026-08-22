import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BillingSummaryResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { readPlanUsage } from '../plan-presentation';
import { BILLING_SECTION_IDS } from '../constants';
import { PlansGrid } from './PlansGrid';
import { SubscriptionPanel } from './SubscriptionPanel';

/**
 * The billing screen's two empty states, against TAR-515's rule: an empty state
 * names the next step, or it is quiet. Both of these landed with TAR-619 saying
 * what was missing and offering no way to fix it — the plans one told an admin
 * to contact support without an address, which is the same gap the WhatsApp
 * panel had.
 */

const env = vi.hoisted(() => ({ webEnv: { supportEmail: null as string | null } }));

vi.mock('@/lib/config/env', () => env);

/** The lazy checkout button pulls a client chunk this test has no need of. */
vi.mock('./billing-widgets.lazy', () => ({
  LazyPlanCheckoutButton: () => null,
}));

afterEach(() => {
  env.webEnv = { supportEmail: null };
});

const ENTITLEMENTS: BillingSummaryResponse['entitlements'] = {
  features: [],
  limits: {
    seats: 10,
    conversationsPerPeriod: 2500,
    whatsappNumbers: 1,
    teams: 3,
    knowledgeDocuments: 25,
  },
};

function summary(): BillingSummaryResponse {
  return {
    subscription: null,
    plan: null,
    entitlements: ENTITLEMENTS,
    usage: { seatsUsed: 3, seatsPending: 1, conversationsThisPeriod: 120 },
    cancelsAt: null,
  };
}

describe('SubscriptionPanel, with nothing bought yet', () => {
  it('explains the trial and points at the plans on the same page', () => {
    const data = summary();

    render(
      <SubscriptionPanel
        summary={data}
        readings={readPlanUsage(data.usage, ENTITLEMENTS.limits)}
      />,
    );

    expect(screen.getByText(content.billing.noSubscriptionHeading)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: content.billing.noSubscriptionAction }),
    ).toHaveAttribute('href', `#${BILLING_SECTION_IDS.plans}`);
  });

  /**
   * The meters are the reason this is an empty state rather than a hidden
   * section: a trial has bought nothing and still has real limits to hit.
   */
  it('still renders both meters', () => {
    const data = summary();

    render(
      <SubscriptionPanel
        summary={data}
        readings={readPlanUsage(data.usage, ENTITLEMENTS.limits)}
      />,
    );

    expect(screen.getByText(content.billing.seatsHeading)).toBeInTheDocument();
    expect(screen.getByText(content.billing.conversationsHeading)).toBeInTheDocument();
  });
});

describe('PlansGrid, with nothing on sale', () => {
  it('offers the configured support address, since the copy says to write to it', () => {
    env.webEnv = { supportEmail: 'help@operator.example' };

    render(<PlansGrid plans={[]} canManage />);

    expect(screen.getByText(content.billing.plansEmptyHeading)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: content.billing.plansEmptySupportAction }),
    ).toHaveAttribute(
      'href',
      `mailto:help@operator.example?subject=${encodeURIComponent(content.billing.plansEmptySupportSubject)}`,
    );
  });

  it('keeps the explanation and drops the link where no address is configured', () => {
    render(<PlansGrid plans={[]} canManage />);

    expect(screen.getByText(content.billing.plansEmptyBody)).toBeInTheDocument();
    // A mailto to nowhere is worse than a sentence telling somebody to ask.
    expect(
      screen.queryByRole('link', { name: content.billing.plansEmptySupportAction }),
    ).toBeNull();
  });
});
