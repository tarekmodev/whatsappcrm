import type { BillingSummaryResponse, SubscriptionStatus } from '@whatsappcrm/contracts';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { Notice } from '@/components/ui/Notice';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { TextLink } from '@/components/ui/TextLink';
import { UsageMeter } from '@/components/ui/UsageMeter';
import { AutoGrid } from '@/components/layout/AutoGrid';
import { Stack } from '@/components/layout/Stack';
import { useContent, type Content } from '@/lib/content';
import { detailTone, type UsageReading } from '@/lib/plan/usage-reading';
import { BILLING_SECTION_IDS } from '../constants';
import { formatCount, formatSeatPrice, type PlanUsageReadings } from '../plan-presentation';

/**
 * What `GET /api/v1/billing/subscription` says, rendered: the plan, its dates,
 * its price, and the two meters. Usage:
 * `<SubscriptionPanel summary={summary} readings={readings} />`.
 *
 * A server component with no interactivity, so none of this reaches the client
 * bundle — the only client boundaries below it are the `RelativeTime` values,
 * which need a mount to phrase themselves.
 *
 * **The meters render even when there is no subscription**, and that is the
 * point of splitting `entitlements` from `plan` in the contract: a workspace on
 * trial has bought nothing and still has real limits it can hit. Only the rows
 * that describe a *purchase* — status, price, renewal — are hidden.
 *
 * Which is exactly why what replaces them is **a line, not an empty state**
 * (TAR-711). The card was wearing the full empty-state anatomy, icon and all,
 * directly above two populated meters: the card is not empty, the plan is unset,
 * and those are different statements. `EmptyState` is kept for surfaces that
 * genuinely have nothing to show.
 *
 * The meters take `detailTone` rather than the reading's own tone, because this
 * page has a banner above them that carries the allowance warning — see the rule
 * for why three amber signals for two facts leave nothing to escalate to.
 */
export function SubscriptionPanel({
  summary,
  readings,
}: {
  summary: BillingSummaryResponse;
  readings: PlanUsageReadings;
}) {
  const content = useContent();

  return (
    <Stack gap="5">
      {summary.subscription === null ? (
        // Quiet rather than filled: nothing is wrong and nothing needs acting
        // on. The link is inside the sentence because it *is* the next step —
        // the grid is under the fold on a phone, and this is the same page, so
        // the anchor is the whole of the action.
        <Notice tone="info" variant="quiet">
          {content.billing.noSubscriptionNotice}{' '}
          <TextLink href={`#${BILLING_SECTION_IDS.plans}`}>
            {content.billing.noSubscriptionAction}
          </TextLink>
        </Notice>
      ) : (
        <DetailList items={subscriptionDetails(summary, content)} />
      )}

      <AutoGrid minItemWidth="16rem" gap="5">
        <UsageMeter
          heading={content.billing.seatsHeading}
          summary={usageSummary(readings.seats, content, {
            capped: content.billing.seatsUsage,
            uncapped: content.billing.seatsUsageUnlimited,
          })}
          ratio={readings.seats.ratio}
          value={readings.seats.used}
          max={readings.seats.cap ?? undefined}
          tone={detailTone(readings.seats)}
        >
          {summary.usage.seatsPending === 0
            ? undefined
            : content.billing.seatsPendingNote(summary.usage.seatsPending)}
        </UsageMeter>

        <UsageMeter
          heading={content.billing.conversationsHeading}
          summary={usageSummary(readings.conversations, content, {
            capped: content.billing.conversationsUsage,
            uncapped: content.billing.conversationsUsageUnlimited,
          })}
          ratio={readings.conversations.ratio}
          value={readings.conversations.used}
          max={readings.conversations.cap ?? undefined}
          tone={detailTone(readings.conversations)}
        />
      </AutoGrid>
    </Stack>
  );
}

/**
 * Plan, status, seats and price always; each date only when it is set.
 *
 * The renewal row changes its own term rather than its value: on a subscription
 * that is closing, `currentPeriodEnd` is the day access *ends*, and calling that
 * "Renews" would be the single most misleading row on the page.
 */
function subscriptionDetails(
  summary: BillingSummaryResponse,
  content: Content,
): readonly DetailListItem[] {
  const { subscription, plan } = summary;

  if (subscription === null) {
    return [];
  }

  const items: DetailListItem[] = [
    {
      id: 'plan',
      term: content.billing.planLabel,
      // `plan` is nullable independently of `subscription` — a subscription on a
      // plan the catalogue no longer carries is a real state, and the key is
      // still the truth about what is being billed.
      value: plan?.name ?? subscription.planKey,
    },
    {
      id: 'status',
      term: content.billing.statusLabel,
      value: (
        <Badge tone={SUBSCRIPTION_STATUS_TONES[subscription.status]}>
          {content.billing.statuses[subscription.status]}
        </Badge>
      ),
    },
    {
      id: 'seats',
      term: content.billing.seatsLabel,
      value: formatCount(subscription.seats, content.locale),
    },
  ];

  if (plan !== null) {
    items.push({
      id: 'price',
      term: content.billing.priceLabel,
      value: `${formatSeatPrice(plan.pricePerSeat, content.locale)} ${content.billing.seatCadence[plan.interval]}`,
    });
  }

  if (subscription.trialEndsAt !== null) {
    items.push({
      id: 'trial-ends-at',
      term: content.billing.trialEndsLabel,
      value: (
        <RelativeTime
          isoTimestamp={subscription.trialEndsAt}
          label={content.billing.trialEndsLabel}
        />
      ),
    });
  }

  const periodTerm = subscription.cancelAtPeriodEnd
    ? content.billing.endsLabel
    : content.billing.renewsLabel;

  items.push({
    id: 'current-period-end',
    term: periodTerm,
    value: <RelativeTime isoTimestamp={subscription.currentPeriodEnd} label={periodTerm} />,
  });

  return items;
}

/**
 * One tone per subscription state. `canceled` is `warning` rather than `danger`
 * on purpose: the workspace is fully serviceable until the period ends, and a
 * red badge would say otherwise on the day somebody clicked cancel.
 */
const SUBSCRIPTION_STATUS_TONES: Record<SubscriptionStatus, BadgeTone> = {
  trialing: 'info',
  active: 'success',
  past_due: 'danger',
  canceled: 'warning',
  incomplete: 'warning',
};

/**
 * Numbers are formatted with `Intl` against the content module's own locale —
 * never the browser's, which would differ from the server's and produce a
 * hydration mismatch on any four-figure conversation count.
 */
function usageSummary(
  reading: UsageReading,
  content: Content,
  copy: { capped: (used: string, cap: string) => string; uncapped: (used: string) => string },
): string {
  const used = formatCount(reading.used, content.locale);

  return reading.cap === null
    ? copy.uncapped(used)
    : copy.capped(used, formatCount(reading.cap, content.locale));
}
