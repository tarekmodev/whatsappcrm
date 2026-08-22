import type { PlanListResponse } from '@whatsappcrm/contracts';
import { AutoGrid } from '@/components/layout/AutoGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { useContent } from '@/lib/content';
import { PlanCard } from './PlanCard';
import { PlanCardSkeleton } from './PlanCard.Skeleton';
import { LazyPlanCheckoutButton } from './billing-widgets.lazy';

/**
 * Every tier the tenant may see, as a row of cards. Usage:
 * `<PlansGrid plans={plans} canManage={canManage} />`.
 *
 * The grid is `auto-fit` rather than a breakpoint ladder, so it reflows
 * continuously from one card at 320px to four on a wide screen with no media
 * query to keep in step with the tier count.
 *
 * The list renders through **one** item component, and the control inside each
 * card is passed in from here rather than chosen by the card: a reader without
 * `billing:manage` gets the same cards with no buttons, instead of a second
 * near-identical read-only grid.
 */
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
      <EmptyState
        heading={content.billing.plansEmptyHeading}
        body={content.billing.plansEmptyBody}
      />
    );
  }

  return (
    <AutoGrid minItemWidth="17rem" gap="4">
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
              />
            ) : undefined
          }
        />
      ))}
    </AutoGrid>
  );
}

/**
 * The fallback. The same grid with the same minimum track, holding the card's
 * own skeleton — so the columns land where the real cards will and the page does
 * not reflow when they arrive.
 *
 * Four cards, matching the tiers a catalogue realistically carries. A count is
 * unavoidable in a skeleton for a list whose length is unknown; four is the one
 * that fills a wide screen's row exactly and wraps the same way a real set does.
 *
 * One announcement for the whole grid, not one per card.
 *
 * Changed in the same commit as the grid it stands in for.
 */
export function PlansGridSkeleton() {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.billing.loading} />
      <AutoGrid minItemWidth="17rem" gap="4">
        {Array.from({ length: SKELETON_CARD_COUNT }, (_unused, index) => (
          <PlanCardSkeleton key={index} />
        ))}
      </AutoGrid>
    </>
  );
}

const SKELETON_CARD_COUNT = 4;
