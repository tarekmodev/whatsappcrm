import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { parseCheckoutOutcome, searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { requireAnyPermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import {
  BillingSections,
  BillingSectionsSkeleton,
  BILLING_PERMISSIONS,
} from '@/features/billing/components/BillingSections';

/**
 * Plans, usage and billing (TAR-37). Composition only — gate, header, and the
 * section group behind its own error and Suspense boundaries.
 *
 * Gated on *either* permission rather than both, because the page is two
 * surfaces: `billing:read` for the plans and the meters, `billing:manage` for
 * the controls that spend money. `settingsNavItems` hides the entry on the same
 * rule. Both are UX; the API enforces each endpoint independently.
 *
 * The two search parameters are how a *third-party* page hands the browser back —
 * `successPath` and `cancelPath` are what the checkout was opened with, and the
 * API composed them against this tenant's own origin. Both are narrowed here
 * before anything reads them: `?checkout=` through `parseCheckoutOutcome`, and
 * `?plan=` only ever compared against the subscription's own `planKey`, never
 * rendered.
 */

export const metadata: Metadata = {
  title: `${content.billing.title} · ${content.app.name}`,
  description: content.billing.subtitle,
};

/**
 * Live usage and a subscription a provider webhook can change between two
 * requests. Nothing here is cacheable, and a cached plan list is a tenant told
 * it can still invite somebody it cannot.
 */
export const dynamic = 'force-dynamic';

const BILLING_SETTINGS_PERMISSIONS = [
  BILLING_PERMISSIONS.read,
  BILLING_PERMISSIONS.manage,
] as const;

export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const session = await requireAnyPermission(BILLING_SETTINGS_PERMISSIONS);

  if (session === null) {
    return <ForbiddenState />;
  }

  const params = await searchParams;
  const checkout = parseCheckoutOutcome(firstSearchParam(params[searchParamKeys.billingCheckout]));
  const planKey = firstSearchParam(params[searchParamKeys.billingPlan]);

  return (
    <Stack gap="5">
      <PageHeader title={content.billing.title} subtitle={content.billing.subtitle} />
      <SectionErrorBoundary>
        {/* Keyed on the outcome so returning from checkout re-runs the read
            rather than reusing the subscription this page rendered before the
            user left for the provider's page. */}
        <Suspense key={checkout ?? ''} fallback={<BillingSectionsSkeleton />}>
          <BillingSections
            canManage={session.checker.can(BILLING_PERMISSIONS.manage)}
            checkout={checkout}
            planKey={planKey}
          />
        </Suspense>
      </SectionErrorBoundary>
    </Stack>
  );
}
