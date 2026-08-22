import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { ReportRangeFilters } from '@/features/reports/components/ReportRangeFilters';
import { DashboardSectionsSkeleton } from '@/features/reports/components/DashboardSections';
import { defaultRange, todayInUtc } from '@/features/reports/report-params';

/**
 * Route-level skeleton, composed from the page's own section skeletons and the
 * same frame.
 *
 * The range controls are the real ones, not a placeholder: they render from the
 * content layer and from today's date, so there is nothing about them to wait
 * for, and drawing a skeleton over something already known would be slower *and*
 * emptier. They show the default range, because a route-level `loading.tsx`
 * receives no search parameters — the page's own Suspense fallback, which is what
 * a range change shows, has the applied ones.
 *
 * `isScopeNarrowed` is `false` for the same reason `tickets/loading.tsx` passes
 * `canReadAll={false}`: the session is not resolved this early, and claiming a
 * narrowing that may not apply is worse than the line arriving with the figures.
 */
export default function ReportsLoading() {
  const today = todayInUtc(new Date());
  const params = { ...defaultRange(today), scope: 'all' } as const;

  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader title={content.reports.title} subtitle={content.reports.subtitle} />
        <ReportRangeFilters params={params} today={today} />
        {/* No `sort` for the same reason as the range above: this file receives
            no search parameters, so the breakdown's placeholder shows the API's
            own order — which is also what an unsorted arrival gets. */}
        <DashboardSectionsSkeleton params={params} isScopeNarrowed={false} />
      </Stack>
    </PageShell>
  );
}
