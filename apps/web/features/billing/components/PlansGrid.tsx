import type { PlanListResponse } from '@whatsappcrm/contracts';
import { AutoGrid } from '@/components/layout/AutoGrid';
import { Stack } from '@/components/layout/Stack';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { TextLink } from '@/components/ui/TextLink';
import { webEnv } from '@/lib/config/env';
import { useContent } from '@/lib/content';
import { mailto } from '@/lib/mailto';
import { planCardIds } from '../constants';
import { CheckoutCoordinator } from './CheckoutCoordinator';
import { PlanCard } from './PlanCard';
import { PlanCardSkeleton } from './PlanCard.Skeleton';
import { LazyPlanCheckoutButton } from './billing-widgets.lazy';

/**
 * Every tier the tenant may see, as a list of cards. Usage:
 * `<PlansGrid plans={plans} canManage={canManage} />`.
 *
 * **Three columns, never four.** `auto-fit` on its own put five tiers out as
 * four across and one alone underneath at 1,512px, and as 2+2+1 at 1,024px — the
 * most expensive tier, the one the page most wants to sell, looking like a
 * layout accident (TAR-711). The track minimum is now narrow enough that three
 * columns still fit at 64rem with the rail open, and the grid is capped at three
 * so a wider screen spends the room on wider cards rather than on a fourth
 * column. Five tiers wrap 3+2 from 64rem up and 2+2+1 only below it, where three
 * genuinely do not fit.
 *
 * A `<ul>`, so a screen reader can be told there are five of these and move
 * through them; each card names itself with its tier *and* its price.
 *
 * The list renders through **one** item component, and the control inside each
 * card is passed in from here rather than chosen by the card: a reader without
 * `billing:manage` gets the same cards with no buttons, instead of a second
 * near-identical read-only grid. That is also what keeps the card's region count
 * uniform — the control's row is present for every card or for none, never per
 * tier.
 */

/**
 * The narrowest a plan card may get before the grid drops a column, and the
 * ceiling on how many it may draw. The pair is what stops a fifth tier being
 * orphaned: see `AutoGrid`'s cap rule for the arithmetic that ties them.
 */
const PLAN_CARD_MIN_WIDTH = '12rem';
const PLAN_COLUMNS_MAX = 3;

export function PlansGrid({
  plans,
  canManage,
}: {
  plans: PlanListResponse['plans'];
  canManage: boolean;
}) {
  const content = useContent();

  if (plans.length === 0) {
    return (
      // `settings` rather than `billing`, which the panel above already uses:
      // the two can be on screen together, and this is not "you have no plan" —
      // it is the operator not having put one on sale, the same shape as the
      // WhatsApp panel with no Meta app configured. Like that one, the copy says
      // "contact support", so the state offers it where an address is set.
      <EmptyState
        icon="settings"
        title={content.billing.plansEmptyHeading}
        description={content.billing.plansEmptyBody}
        action={
          webEnv.supportEmail === null ? undefined : (
            <TextLink
              isExternal
              href={mailto(webEnv.supportEmail, content.billing.plansEmptySupportSubject)}
            >
              {content.billing.plansEmptySupportAction}
            </TextLink>
          )
        }
      />
    );
  }

  const grid = (
    <AutoGrid
      as="ul"
      minItemWidth={PLAN_CARD_MIN_WIDTH}
      maxColumns={PLAN_COLUMNS_MAX}
      gap="4"
      // `list-style: none` drops list semantics in Safari, and the count is the
      // part a reader comparing tiers needs.
      role="list"
    >
      {plans.map((plan) => (
        <PlanCard
          key={plan.key}
          plan={plan}
          action={
            canManage ? (
              <LazyPlanCheckoutButton
                planKey={plan.key}
                planName={plan.name}
                isCurrent={plan.isCurrent}
                isSelectable={plan.isSelectable}
                reasonId={plan.blockedBy.length === 0 ? undefined : planCardIds(plan.key).blocked}
              />
            ) : undefined
          }
        />
      ))}
    </AutoGrid>
  );

  // Nothing to coordinate where there are no controls to press.
  return canManage ? (
    <Stack gap="3">
      <CheckoutCoordinator busyNote={content.billing.checkoutRedirectNote}>
        {grid}
      </CheckoutCoordinator>
    </Stack>
  ) : (
    grid
  );
}

/**
 * The fallback. The same list with the same track minimum and the same column
 * cap, holding the card's own skeleton — so the columns land where the real
 * cards will and the page does not reflow when they arrive.
 *
 * Five cards rather than four, matching the catalogue this page actually
 * carries: a count is unavoidable in a skeleton for a list whose length is
 * unknown, and five is the one that wraps 3+2 exactly as the real set does.
 *
 * One announcement for the whole list, not one per card.
 *
 * Changed in the same commit as the grid it stands in for.
 */
export function PlansGridSkeleton() {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.billing.loading} />
      <AutoGrid
        as="ul"
        minItemWidth={PLAN_CARD_MIN_WIDTH}
        maxColumns={PLAN_COLUMNS_MAX}
        gap="4"
        aria-hidden="true"
      >
        {Array.from({ length: SKELETON_CARD_COUNT }, (_unused, index) => (
          <PlanCardSkeleton key={index} />
        ))}
      </AutoGrid>
    </>
  );
}

const SKELETON_CARD_COUNT = 5;
