import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { content } from '@/content/en';
import { planCardIds } from '../constants';
import { CheckoutCoordinator } from './CheckoutCoordinator';
import { PlanCheckoutButton } from './PlanCheckoutButton';

/**
 * The control that spends money, and the two states TAR-711 found undesigned.
 *
 * **Unavailable** was a blanket opacity over the accent, which reads as a button
 * mid-press rather than one that cannot be pressed — and the native `disabled`
 * attribute it carried meant the sentence explaining why never reached a
 * keyboard or a screen reader at all.
 *
 * **Pending** assumed the redirect always lands. It does not always land
 * quickly, and while it is in flight every *other* tier on the page is still a
 * live button that would mint a second hosted session.
 */

const actions = vi.hoisted(() => ({
  startCheckoutAction: vi.fn(),
}));

vi.mock('../billing.actions', () => actions);

afterEach(() => {
  actions.startCheckoutAction.mockReset();
});

/**
 * A hosted session that never arrives, which is what the pending state is *for*:
 * the button is deliberately left pending through the navigation, so there is no
 * settled outcome to wait for here either.
 */
function checkoutThatNeverLands(): void {
  actions.startCheckoutAction.mockReturnValue(new Promise(() => undefined));
}

describe('PlanCheckoutButton, on a tier the workspace cannot take', () => {
  it('is inert but still reachable, so its reason is announced', () => {
    render(
      <>
        <PlanCheckoutButton
          planKey="solo"
          planName="Solo"
          isCurrent={false}
          isSelectable={false}
          reasonId={planCardIds('solo').blocked}
        />
        <p id={planCardIds('solo').blocked}>{content.billing.blockedBy.seats}</p>
      </>,
    );

    const control = screen.getByRole('button', { name: content.billing.choosePlan('Solo') });

    expect(control).toHaveAttribute('aria-disabled', 'true');
    // Not the native attribute: a disabled button leaves the tab order, and an
    // explanation nobody can reach is not an explanation.
    expect(control).not.toBeDisabled();
    expect(control).toHaveAccessibleDescription(content.billing.blockedBy.seats);
  });

  it('does not open a checkout when pressed anyway', () => {
    render(
      <PlanCheckoutButton planKey="solo" planName="Solo" isCurrent={false} isSelectable={false} />,
    );

    fireEvent.click(screen.getByRole('button', { name: content.billing.choosePlan('Solo') }));

    expect(actions.startCheckoutAction).not.toHaveBeenCalled();
  });
});

describe('PlanCheckoutButton, while a checkout is opening', () => {
  it('says what the wait is for and stops every other tier being pressed', async () => {
    checkoutThatNeverLands();

    render(
      <CheckoutCoordinator busyNote={content.billing.checkoutRedirectNote}>
        <PlanCheckoutButton planKey="growth" planName="Growth" isCurrent={false} isSelectable />
        <PlanCheckoutButton planKey="scale" planName="Scale" isCurrent={false} isSelectable />
      </CheckoutCoordinator>,
    );

    fireEvent.click(screen.getByRole('button', { name: content.billing.choosePlan('Growth') }));

    await waitFor(() => {
      expect(screen.getByText(content.billing.checkoutRedirectNote)).toBeInTheDocument();
    });

    // The pressed control announces what it is doing; the sibling goes inert so
    // a second hosted session cannot be minted from the same page.
    expect(screen.getByRole('button', { name: content.billing.checkoutPending })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(
      screen.getByRole('button', { name: content.billing.choosePlan('Scale') }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('leaves the other tiers alone when nothing is in flight', () => {
    render(
      <CheckoutCoordinator busyNote={content.billing.checkoutRedirectNote}>
        <PlanCheckoutButton planKey="growth" planName="Growth" isCurrent={false} isSelectable />
        <PlanCheckoutButton planKey="scale" planName="Scale" isCurrent={false} isSelectable />
      </CheckoutCoordinator>,
    );

    expect(screen.queryByText(content.billing.checkoutRedirectNote)).toBeNull();
    expect(
      screen.getByRole('button', { name: content.billing.choosePlan('Scale') }),
    ).not.toHaveAttribute('aria-disabled');
  });
});
