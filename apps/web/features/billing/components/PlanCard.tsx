import type { ReactNode } from 'react';
import { PLAN_FEATURES, type PlanListResponse } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { Stack } from '@/components/layout/Stack';
import { useContent, type Content } from '@/lib/content';
import { planCardIds } from '../constants';
import { formatCount, formatSeatPrice, orderedFeatures } from '../plan-presentation';
import { PlanBullets, type PlanBullet } from './PlanBullets';
import styles from './PlanCard.module.css';

export type PlanListing = PlanListResponse['plans'][number];

/**
 * One tier: what it costs, what it allows, what it unlocks, and the control that
 * moves onto it. Usage: `<PlanCard plan={plan} action={<PlanCheckoutButton …/>} />`.
 *
 * A server component with the interactive part passed **in** as a slot, so the
 * card's copy, the price formatting and the feature list stay off the client
 * bundle and only the button crosses the boundary. That is also what lets a
 * reader without `billing:manage` get the same card with no control instead of a
 * second, near-identical read-only component.
 *
 * **One anatomy, five tiers.** Name, price, allowances, includes, control — in
 * that order, every time, each in its own region of a subgrid so the five blocks
 * line up across a row (TAR-711). Comparing tiers is the entire job of this
 * layout, and before that the cards were content-height with two of the five
 * blocks in a different shape on one tier. A tier with less to say shows fewer
 * bullets; it never shows a different kind of block.
 *
 * **The card never decides whether it can be chosen.** `isSelectable` and
 * `blockedBy` arrive from the API, because they depend on live usage the console
 * does not hold — a downgrade below current usage is refused before checkout
 * rather than after payment, and the card's job is to say *which* ceiling blocks
 * it, not to work that out. The sentence sits beneath the control and the
 * control points `aria-describedby` at it, so it is read as that button's reason
 * rather than as a warning about the plan.
 *
 * An `<li>` in the grid's list, named by its tier *and* its price, so a screen
 * reader can move between five priced options as units rather than reading one
 * long run of prices and feature lists.
 */
export function PlanCard({ plan, action }: { plan: PlanListing; action?: ReactNode }) {
  const content = useContent();
  const ids = planCardIds(plan.key);
  const features = orderedFeatures(plan.entitlements, PLAN_FEATURES);

  return (
    <li
      className={styles.card}
      aria-labelledby={`${ids.name} ${ids.amount} ${ids.cadence}`}
      data-current={plan.isCurrent ? 'true' : undefined}
      // Four regions, or five once there is a control to align across the row.
      // Uniform within a grid, because whether the control renders is the
      // reader's permission and not the tier's — see `PlansGrid`.
      data-has-action={action === undefined ? undefined : 'true'}
    >
      <div className={styles.header}>
        <h3 id={ids.name} className={styles.name}>
          {plan.name}
        </h3>
        {plan.isCurrent ? <Badge tone="accent">{content.billing.currentPlanBadge}</Badge> : null}
      </div>

      <p className={styles.price}>
        <span id={ids.amount} className={styles.amount}>
          {formatSeatPrice(plan.pricePerSeat, content.locale)}
        </span>
        <span id={ids.cadence} className={styles.cadence}>
          {content.billing.seatCadence[plan.interval]}
        </span>
      </p>

      <Stack gap="2" as="section">
        <h4 id={ids.allowances} className={styles.groupHeading}>
          {content.billing.allowancesHeading}
        </h4>
        <PlanBullets items={allowanceBullets(plan, content)} labelledBy={ids.allowances} />
      </Stack>

      <Stack gap="2" as="section">
        <h4 id={ids.includes} className={styles.groupHeading}>
          {content.billing.featuresHeading}
        </h4>
        <PlanBullets
          labelledBy={ids.includes}
          items={
            features.length === 0
              ? [{ id: 'baseline', label: content.billing.noFeatures }]
              : features.map((feature) => ({
                  id: feature,
                  label: content.billing.features[feature],
                }))
          }
        />
      </Stack>

      {action === undefined ? null : (
        <div className={styles.action}>
          {action}
          {plan.blockedBy.length === 0 ? null : (
            <p id={ids.blocked} className={styles.reason}>
              {plan.blockedBy.map((reason) => content.billing.blockedBy[reason]).join(' ')}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The two metered allowances, as bullets.
 *
 * `null` is unlimited, per `PlanLimitsSchema`, and gets its own sentence rather
 * than a number — "0 seats" and "unlimited seats" are the two readings a reader
 * must never confuse, and they are one keystroke apart in the data.
 */
function allowanceBullets(plan: PlanListing, content: Content): readonly PlanBullet[] {
  const { seats, conversationsPerPeriod } = plan.entitlements.limits;

  return [
    {
      id: 'seats',
      label:
        seats === null
          ? content.billing.allowanceSeatsUnlimited
          : content.billing.allowanceSeats(formatCount(seats, content.locale)),
    },
    {
      id: 'conversations',
      label:
        conversationsPerPeriod === null
          ? content.billing.allowanceConversationsUnlimited
          : content.billing.allowanceConversations(
              formatCount(conversationsPerPeriod, content.locale),
            ),
    },
  ];
}
