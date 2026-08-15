import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PlanLimits, TenantLifecycleResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { PlanStatusPanel } from './PlanStatusPanel';

/**
 * TAR-409's plan-status and seat-usage criteria at the panel level.
 *
 * The assertions are on the *sentence*, not on the bar: the bar is `aria-hidden`
 * decoration and the summary is what actually carries the numbers, so a test
 * that read the bar would pass while the panel said nothing to a screen reader.
 */

const LIMITS: PlanLimits = {
  seats: 5,
  conversationsPerPeriod: 1000,
  whatsappNumbers: 1,
  teams: 2,
  knowledgeDocuments: 10,
};

function lifecycle(overrides: Partial<TenantLifecycleResponse> = {}): TenantLifecycleResponse {
  return {
    status: 'trialing',
    trialEndsAt: null,
    gracePeriodEndsAt: null,
    purgeAt: null,
    plan: { key: 'trial', name: 'Trial', entitlements: { features: [], limits: LIMITS } },
    usage: { seatsUsed: 2, seatsPending: 0, conversationsThisPeriod: 120 },
    ...overrides,
  };
}

describe('PlanStatusPanel', () => {
  it('names the lifecycle state in words, never by colour alone', () => {
    render(<PlanStatusPanel lifecycle={lifecycle({ status: 'past_due' })} />);

    expect(screen.getByText(content.workspace.statuses.past_due)).toBeInTheDocument();
    expect(screen.getByText(content.workspace.planLabel)).toBeInTheDocument();
    expect(screen.getByText('Trial')).toBeInTheDocument();
  });

  it('shows agents used against the seat cap', () => {
    render(<PlanStatusPanel lifecycle={lifecycle({ usage: seats(4, 0) })} />);

    expect(screen.getByText(content.workspace.seatsUsage('4', '5'))).toBeInTheDocument();
  });

  it('counts an outstanding invitation towards the cap and says so', () => {
    render(<PlanStatusPanel lifecycle={lifecycle({ usage: seats(3, 1) })} />);

    expect(screen.getByText(content.workspace.seatsUsage('4', '5'))).toBeInTheDocument();
    expect(screen.getByText(content.workspace.seatsPendingNote(1))).toBeInTheDocument();
  });

  /**
   * The case the default fixture puts on screen, and the one worth pinning: at
   * the cap *because of* an invitation nobody has accepted. The summary reads
   * "5 of 5 seats in use" while only four people can sign in, so the note has to
   * say that one is outstanding — withdrawing it is the cheapest way to free a
   * seat, and a bare "every seat is taken" hides that there is one to withdraw.
   */
  it('names the outstanding invitations when they are what pushed it to the cap', () => {
    render(<PlanStatusPanel lifecycle={lifecycle({ usage: seats(4, 1) })} />);

    expect(screen.getByText(content.workspace.seatsUsage('5', '5'))).toBeInTheDocument();
    expect(screen.getByText(content.workspace.seatsAtCapPendingNote(1))).toBeInTheDocument();
  });

  it('drops the invitation clause when the cap is reached by active agents alone', () => {
    render(<PlanStatusPanel lifecycle={lifecycle({ usage: seats(5, 0) })} />);

    expect(screen.getByText(content.workspace.seatsAtCapNote)).toBeInTheDocument();
  });

  /** ADR 0009 risk 4: there is no self-service upgrade until billing ships. */
  it('names a support route rather than a checkout page once a limit is reached', () => {
    render(<PlanStatusPanel lifecycle={lifecycle({ usage: seats(5, 0) })} />);

    expect(screen.getByText(content.workspace.upgradeUnavailableNotice)).toBeInTheDocument();
  });

  it('says nothing about upgrading while both allowances have room', () => {
    render(<PlanStatusPanel lifecycle={lifecycle()} />);

    expect(screen.queryByText(content.workspace.upgradeUnavailableNotice)).not.toBeInTheDocument();
  });

  it('formats a four-figure conversation count for the content module’s locale', () => {
    render(<PlanStatusPanel lifecycle={lifecycle({ usage: seats(1, 0, 1200) })} />);

    expect(
      screen.getByText(content.workspace.conversationsUsage('1,200', '1,000')),
    ).toBeInTheDocument();
  });

  it('says a null limit is unlimited rather than rendering a bar against zero', () => {
    render(
      <PlanStatusPanel
        lifecycle={lifecycle({
          plan: {
            key: 'enterprise',
            name: 'Enterprise',
            entitlements: { features: [], limits: { ...LIMITS, seats: null } },
          },
          usage: seats(40, 0),
        })}
      />,
    );

    expect(screen.getByText(content.workspace.seatsUsageUnlimited('40'))).toBeInTheDocument();
  });

  it('renders only the dates that are actually set', () => {
    const { container } = render(
      <PlanStatusPanel
        lifecycle={lifecycle({ status: 'trialing', trialEndsAt: '2026-08-29T09:00:00.000Z' })}
      />,
    );

    expect(screen.getByText(content.workspace.trialEndsLabel)).toBeInTheDocument();
    expect(screen.queryByText(content.workspace.purgeLabel)).not.toBeInTheDocument();
    expect([...container.querySelectorAll('time')].map((node) => node.dateTime)).toEqual([
      '2026-08-29T09:00:00.000Z',
    ]);
  });
});

function seats(
  seatsUsed: number,
  seatsPending: number,
  conversationsThisPeriod = 120,
): TenantLifecycleResponse['usage'] {
  return { seatsUsed, seatsPending, conversationsThisPeriod };
}
