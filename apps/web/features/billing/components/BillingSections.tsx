import type { Permission } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import { LazyBoundary } from '@/components/ui/LazyBoundary';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { content } from '@/content/en';
import type { CheckoutOutcome } from '@/lib/routes';
import { loadBilling } from '../billing.data';
import { BILLING_SECTION_IDS } from '../constants';
import { readPlanUsage, reportCheckout } from '../plan-presentation';
import { CancellationBanner } from './CancellationBanner';
import { CheckoutOutcomeBanner } from './CheckoutOutcomeBanner';
import { PlansGrid, PlansGridSkeleton } from './PlansGrid';
import { SubscriptionPanel } from './SubscriptionPanel';
import { SubscriptionPanelSkeleton } from './SubscriptionPanel.Skeleton';
import { VolumeThresholdBanner } from './VolumeThresholdBanner';
import { LazyBillingPortalButton } from './billing-widgets.lazy';

/**
 * Fetches the billing data and composes the page's three sections and its
 * banners. Usage: inside a Suspense boundary on the billing page, with
 * `BillingSectionsSkeleton` as the fallback.
 *
 * A server component, so both reads and the permission decision happen on the
 * server and the client bundle carries neither.
 *
 * **One read, three sections.** The summary and the plan list are two requests
 * because they are two routes in the contract, but they are one *await* — the
 * subscription panel, the plans grid and the portal card all describe the same
 * subscription, and streaming them separately would mean the plans arriving
 * before the plan the tenant is on, with the "current" badge appearing a beat
 * later. They fail together for the same reason, which is what the page's single
 * section boundary is for.
 *
 * The banners are ordered by what somebody needs to read first: what just
 * happened at checkout, then what is about to happen to the subscription, then
 * what is running out.
 */

/** The permissions this surface's controls are gated on, named once. */
export const BILLING_PERMISSIONS = {
  read: 'billing:read',
  manage: 'billing:manage',
} as const satisfies Record<string, Permission>;

export async function BillingSections({
  canManage,
  checkout,
  planKey,
}: {
  canManage: boolean;
  /** How the hosted checkout page sent the browser back, from the URL. */
  checkout: CheckoutOutcome | undefined;
  /** Which plan that checkout was for, from the URL. */
  planKey: string | undefined;
}) {
  const { summary, plans } = await loadBilling();
  const readings = readPlanUsage(summary.usage, summary.entitlements.limits);
  const report = reportCheckout(checkout, planKey, summary);

  return (
    <Stack gap="5">
      <CheckoutOutcomeBanner report={report} />
      <CancellationBanner cancelsAt={summary.cancelsAt} />
      {/* No action: the link would point at the page it is already on. */}
      <VolumeThresholdBanner readings={readings} />

      {canManage ? null : <Notice tone="info">{content.billing.readOnlyNotice}</Notice>}

      <SectionCard
        id={BILLING_SECTION_IDS.current}
        title={content.billing.currentHeading}
        description={content.billing.currentDescription}
      >
        <SubscriptionPanel summary={summary} readings={readings} />
      </SectionCard>

      <SectionCard
        id={BILLING_SECTION_IDS.plans}
        title={content.billing.plansHeading}
        description={content.billing.plansDescription}
      >
        <PlansGrid plans={plans.plans} canManage={canManage} />
      </SectionCard>

      {canManage ? (
        <SectionCard
          id={BILLING_SECTION_IDS.portal}
          title={content.billing.portalHeading}
          description={content.billing.portalDescription}
        >
          <Stack gap="4">
            {summary.subscription === null ? (
              // A portal session needs a subscription to be a portal *for*, and
              // the API answers `not_found` without one. Saying so beats offering
              // a button that can only fail.
              <Notice tone="info">{content.billing.portalUnavailableNotice}</Notice>
            ) : (
              <>
                <p>{content.billing.portalBody}</p>
                <LazyBoundary
                  fallback={<SkeletonLine width="12rem" height="var(--size-control-md)" />}
                >
                  <LazyBillingPortalButton />
                </LazyBoundary>
              </>
            )}
          </Stack>
        </SectionCard>
      ) : null}
    </Stack>
  );
}

/**
 * The fallback. The same stack and gap and the same cards, each holding its own
 * section's skeleton, so the page does not reflow when the data lands.
 *
 * No banner placeholders, deliberately: whether any of the four appears depends
 * on data that has not arrived, and reserving space for one would leave a gap on
 * the common path where there is nothing to warn about. A banner that pushes the
 * cards down when it appears is correct — it is the page telling somebody
 * something they need to read.
 *
 * The portal card is drawn here even though the real sections omit it for a
 * reader without `billing:manage`. Under today's role table nobody reaches this
 * page with one permission and not the other, and the alternative would be
 * threading the permission into the route's `loading.tsx`, which has no session
 * to read.
 *
 * Changed in the same commit as the sections it stands in for.
 */
export function BillingSectionsSkeleton() {
  return (
    <Stack gap="5">
      <SectionCard
        id={BILLING_SECTION_IDS.current}
        title={content.billing.currentHeading}
        description={content.billing.currentDescription}
      >
        <SubscriptionPanelSkeleton />
      </SectionCard>
      <SectionCard
        id={BILLING_SECTION_IDS.plans}
        title={content.billing.plansHeading}
        description={content.billing.plansDescription}
      >
        <PlansGridSkeleton />
      </SectionCard>
      <SectionCard
        id={BILLING_SECTION_IDS.portal}
        title={content.billing.portalHeading}
        description={content.billing.portalDescription}
      >
        <Stack gap="4">
          <SkeletonLine width="100%" />
          <SkeletonLine width="12rem" height="var(--size-control-md)" />
        </Stack>
      </SectionCard>
    </Stack>
  );
}
