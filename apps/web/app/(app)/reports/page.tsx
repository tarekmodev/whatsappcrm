import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { requirePermission } from '@/lib/session/session';
import { isReportScopeNarrowed } from '@/lib/session/permissions';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { ReportRangeFilters } from '@/features/reports/components/ReportRangeFilters';
import {
  DashboardSections,
  DashboardSectionsSkeleton,
} from '@/features/reports/components/DashboardSections';
import { parseReportParams, todayInUtc } from '@/features/reports/report-params';

/**
 * The supervisor's performance dashboard. Composition only: gate, header,
 * filters, and the three sections behind a Suspense boundary with their own
 * skeletons.
 *
 * The range and the scope live in the URL, so a refresh, a copied link and the
 * back button reproduce the same view — and TAR-431's export control has one
 * place to read the applied filters from.
 */

export const metadata: Metadata = {
  title: `${content.reports.title} · ${content.app.name}`,
  description: content.reports.subtitle,
};

/**
 * Per-principal scoping from a live session, and a range that ends today by
 * default. Nothing here is cacheable.
 */
export const dynamic = 'force-dynamic';

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const session = await requirePermission('report:read');

  if (session === null) {
    return <ForbiddenState />;
  }

  const params = await searchParams;
  // The clock is read once, here, and travels as a string. A `Date` in a client
  // component would make the server's markup and the browser's differ.
  const today = todayInUtc(new Date());
  const query = parseReportParams(
    {
      from: firstSearchParam(params[searchParamKeys.reportFrom]),
      to: firstSearchParam(params[searchParamKeys.reportTo]),
      scope: firstSearchParam(params[searchParamKeys.reportScope]),
    },
    today,
  );
  const isScopeNarrowed = isReportScopeNarrowed(session.checker);

  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader title={content.reports.title} subtitle={content.reports.subtitle} />

        <ReportRangeFilters params={query} today={today} />

        <SectionErrorBoundary>
          {/* Keyed on the applied query so changing the range shows the skeleton
              again rather than leaving the previous range's figures on screen
              under a new heading. */}
          <Suspense
            key={`${query.from}:${query.to}:${query.scope}`}
            fallback={<DashboardSectionsSkeleton isScopeNarrowed={isScopeNarrowed} />}
          >
            <DashboardSections params={query} isScopeNarrowed={isScopeNarrowed} />
          </Suspense>
        </SectionErrorBoundary>
      </Stack>
    </PageShell>
  );
}
