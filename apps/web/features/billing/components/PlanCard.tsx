import type { ReactNode } from 'react';
import { PLAN_FEATURES, type PlanListResponse } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/Icon';
import { Notice } from '@/components/ui/Notice';
import { Stack } from '@/components/layout/Stack';
import { useContent, type Content } from '@/lib/content';
import { formatCount, formatSeatPrice, orderedFeatures } from '../plan-presentation';
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
 * **The card never decides whether it can be chosen.** `isSelectable` and
 * `blockedBy` arrive from the API, because they depend on live usage the console
 * does not hold — a downgrade below current usage is refused before checkout
 * rather than after payment, and the card's job is to say *which* ceiling blocks
 * it, not to work that out.
 *
 * `<article>` rather than a `<div>`, with the plan name as its accessible name,
 * so a screen reader can move between tiers as units rather than reading one
 * long run of prices and feature lists.
 */
export function PlanCard({ plan, action }: { plan: PlanListing; action?: ReactNode }) {
  const content = useContent();
  const headingId = `plan-${plan.key}-heading`;
  const features = orderedFeatures(plan.entitlements, PLAN_FEATURES);

  return (
    <article
      className={styles.card}
      aria-labelledby={headingId}
      data-current={plan.isCurrent ? 'true' : undefined}
    >
      <Stack gap="4" className={styles.body}>
        <div className={styles.header}>
          <h3 id={headingId} className={styles.name}>
            {plan.name}
          </h3>
          {plan.isCurrent ? <Badge tone="accent">{content.billing.currentPlanBadge}</Badge> : null}
        </div>

        <p className={styles.price}>
          <span className={styles.amount}>
            {formatSeatPrice(plan.pricePerSeat, content.locale)}
          </span>{' '}
          <span className={styles.cadence}>{content.billing.seatCadence[plan.interval]}</span>
        </p>

        <Stack gap="2" as="section">
          <h4 className={styles.groupHeading}>{content.billing.allowancesHeading}</h4>
          <ul className={styles.list}>
            {allowanceLines(plan, content).map((line) => (
              <li key={line} className={styles.item}>
                {line}
              </li>
            ))}
          </ul>
        </Stack>

        <Stack gap="2" as="section">
          <h4 className={styles.groupHeading}>{content.billing.featuresHeading}</h4>
          {features.length === 0 ? (
            <p className={styles.item}>{content.billing.noFeatures}</p>
          ) : (
            <ul className={styles.list}>
              {features.map((feature) => (
                <li key={feature} className={styles.item}>
                  {/* Decorative: the text beside it is the meaning, and a tick
                      that also announced itself would say everything twice. */}
                  <Icon name="checklist" size="sm" className={styles.tick} />
                  {content.billing.features[feature]}
                </li>
              ))}
            </ul>
          )}
        </Stack>

        {plan.blockedBy.length === 0 ? null : (
          <Notice tone="warning">
            {plan.blockedBy.map((reason) => content.billing.blockedBy[reason]).join(' ')}
          </Notice>
        )}

        {action === undefined ? null : <div className={styles.action}>{action}</div>}
      </Stack>
    </article>
  );
}

/**
 * The two metered allowances, in words.
 *
 * `null` is unlimited, per `PlanLimitsSchema`, and gets its own sentence rather
 * than a number — "0 seats" and "unlimited seats" are the two readings a reader
 * must never confuse, and they are one keystroke apart in the data.
 */
function allowanceLines(plan: PlanListing, content: Content): readonly string[] {
  const { seats, conversationsPerPeriod } = plan.entitlements.limits;

  return [
    seats === null
      ? content.billing.allowanceSeatsUnlimited
      : content.billing.allowanceSeats(formatCount(seats, content.locale)),
    conversationsPerPeriod === null
      ? content.billing.allowanceConversationsUnlimited
      : content.billing.allowanceConversations(formatCount(conversationsPerPeriod, content.locale)),
  ];
}
