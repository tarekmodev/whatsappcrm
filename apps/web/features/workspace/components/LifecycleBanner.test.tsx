import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TenantLifecycleResponse, TenantStatus } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { LifecycleBanner } from './LifecycleBanner';

/**
 * TAR-409's second acceptance criterion: a visible banner for `past_due` and
 * `suspended`.
 *
 * The two things worth pinning are the ones a reviewer cannot see by looking at
 * the fixture, because the fixture workspace is healthy: that the banner appears
 * for exactly the states that need one, and that it names the deadline. A banner
 * that says "you are suspended" without saying when the data goes is missing the
 * half that matters.
 */

const SUSPENDED_AT = '2026-09-01T09:00:00.000Z';
const PURGE_AT = '2026-10-01T09:00:00.000Z';

function lifecycle(overrides: Partial<TenantLifecycleResponse>): TenantLifecycleResponse {
  return {
    status: 'active',
    trialEndsAt: null,
    gracePeriodEndsAt: null,
    purgeAt: null,
    plan: {
      key: 'trial',
      name: 'Trial',
      entitlements: {
        features: [],
        limits: {
          seats: 5,
          conversationsPerPeriod: 1000,
          whatsappNumbers: 1,
          teams: 2,
          knowledgeDocuments: 10,
        },
      },
    },
    usage: { seatsUsed: 1, seatsPending: 0, conversationsThisPeriod: 0 },
    ...overrides,
  };
}

/** `<time>` has no role every testing-library version agrees on; the repo reads
 *  the element directly, as `RelativeTime.test.tsx` does. */
function deadlines(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll('time')].map((node) => node.dateTime);
}

describe('LifecycleBanner', () => {
  it('warns a past-due workspace, and names when it will be suspended', () => {
    const { container } = render(
      <LifecycleBanner
        lifecycle={lifecycle({ status: 'past_due', gracePeriodEndsAt: SUSPENDED_AT })}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      content.workspace.banners.past_due.heading,
    );
    expect(screen.getByText(content.workspace.suspendsLabel)).toBeInTheDocument();
    expect(deadlines(container)).toEqual([SUSPENDED_AT]);
  });

  it('tells a suspended workspace what still works, and when its data goes', () => {
    const { container } = render(
      <LifecycleBanner lifecycle={lifecycle({ status: 'suspended', purgeAt: PURGE_AT })} />,
    );

    const banner = screen.getByRole('status');

    expect(banner).toHaveTextContent(content.workspace.banners.suspended.heading);
    // The reassurance is load-bearing: inbound messages are still stored while a
    // workspace is locked out, and an admin deciding whether to pay needs to know.
    expect(banner).toHaveTextContent(content.workspace.banners.suspended.body);
    expect(screen.getByText(content.workspace.purgeLabel)).toBeInTheDocument();
    expect(deadlines(container)).toEqual([PURGE_AT]);
  });

  it('warns a closing workspace rather than letting it count down in silence', () => {
    render(
      <LifecycleBanner
        lifecycle={lifecycle({ status: 'cancelled', gracePeriodEndsAt: SUSPENDED_AT })}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      content.workspace.banners.cancelled.heading,
    );
  });

  it.each<TenantStatus>(['trialing', 'active', 'deleted'])(
    'renders nothing for %s, which needs no warning here',
    (status) => {
      const { container } = render(<LifecycleBanner lifecycle={lifecycle({ status })} />);

      expect(container).toBeEmptyDOMElement();
    },
  );

  /**
   * A transition that has not written its timer yet. The banner still appears —
   * the state is the warning — but it must not invent a date to sit under it.
   */
  it('omits the deadline when nothing has been scheduled', () => {
    const { container } = render(
      <LifecycleBanner lifecycle={lifecycle({ status: 'suspended' })} />,
    );

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(deadlines(container)).toEqual([]);
  });
});
