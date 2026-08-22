import { Stack } from '@/components/layout/Stack';
import { LazyBoundary } from '@/components/ui/LazyBoundary';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { content } from '@/content/en';
import { loadDashboardMetrics } from '@/features/reports/reports.data';
import { formatReportDate } from '@/features/reports/presentation';
import type { ReportParams } from '@/features/reports/report-params';
import { AgentBreakdownTable, AgentBreakdownTableSkeleton } from './AgentBreakdownTable';
import { DailyVolumeChartSkeleton } from './DailyVolumeChart.Skeleton';
import { MetricSummaryGrid, MetricSummaryGridSkeleton } from './MetricSummaryGrid';
import { LazyDailyVolumeChart } from './report-widgets.lazy';
import styles from './DashboardSections.module.css';

/**
 * The dashboard's three sections. Usage: inside a Suspense boundary on the
 * reports page, with `DashboardSectionsSkeleton` as the fallback.
 *
 * **One fetch, three sections.** The summary, the breakdown and the daily series
 * come out of a single aggregation, which is what makes the totals incapable of
 * disagreeing with the rows beneath them (ADR 0009 decision 1). Splitting them
 * into three requests to win three streaming boundaries would trade that away for
 * a few hundred milliseconds.
 *
 * `isScopeNarrowed` is resolved from the session rather than from the response, so
 * the notice occupies the same space in the skeleton as in the loaded view and
 * the swap does not shift the figures down a line.
 */

export interface DashboardSectionsProps {
  params: ReportParams;
  /** True when the caller lacks `report:read_all` (ADR 0009 decision 6). */
  isScopeNarrowed: boolean;
}

export async function DashboardSections({ params, isScopeNarrowed }: DashboardSectionsProps) {
  const metrics = await loadDashboardMetrics(params);

  return (
    <Stack gap="5">
      <SectionCard
        id="report-summary"
        title={content.reports.summaryHeading}
        description={content.reports.durationBasisNote}
      >
        <Stack gap="3">
          {isScopeNarrowed ? (
            <Notice tone="info">{content.reports.scopeNarrowedNotice}</Notice>
          ) : null}
          {/* The range the API actually resolved, echoed back — not the one that
              was asked for. They are the same today, and saying which is which
              stops a future default or clamp becoming invisible. */}
          <p className={styles.range}>
            {content.reports.rangeSummary(
              formatReportDate(metrics.range.from, content),
              formatReportDate(metrics.range.to, content),
            )}
          </p>
          <SectionErrorBoundary>
            <MetricSummaryGrid metrics={metrics.summary} />
          </SectionErrorBoundary>
        </Stack>
      </SectionCard>

      <SectionCard
        id="report-agents"
        title={content.reports.agentsHeading}
        description={content.reports.agentsDescription}
      >
        <Stack gap="3">
          {/*
            The three sections come out of one fetch, so a *read* that fails
            fails all three — that is ADR 0009 decision 1 and the page-level
            boundary is where it belongs. This is the other failure: the
            breakdown throwing while rendering, which must not take the summary
            above it and the chart below it with it (TAR-515).
          */}
          <SectionErrorBoundary>
            <AgentBreakdownTable rows={metrics.agents} />
          </SectionErrorBoundary>
          <p className={styles.note}>{content.reports.mediansDoNotSumNote}</p>
        </Stack>
      </SectionCard>

      <SectionCard
        id="report-series"
        title={content.reports.seriesHeading}
        description={content.reports.seriesDescription}
      >
        {/* The one lazy boundary on this screen: the only section a supervisor
            can answer their question without. */}
        <LazyBoundary fallback={<DailyVolumeChartSkeleton />} deferUntilVisible>
          <LazyDailyVolumeChart series={metrics.series} />
        </LazyBoundary>
      </SectionCard>
    </Stack>
  );
}

/**
 * Composed from the same three section frames and each section's own skeleton.
 *
 * Every heading, description and note is the **real** string — they render from
 * the content layer, so there is nothing about them to wait for. Only the range
 * line is drawn as a placeholder: it names dates the response has not echoed yet,
 * and it is one line tall either way.
 */
export function DashboardSectionsSkeleton({
  isScopeNarrowed = false,
}: {
  isScopeNarrowed?: boolean;
}) {
  return (
    <Stack gap="5">
      <SectionCard
        id="report-summary"
        title={content.reports.summaryHeading}
        description={content.reports.durationBasisNote}
      >
        <Stack gap="3">
          {isScopeNarrowed ? (
            <Notice tone="info">{content.reports.scopeNarrowedNotice}</Notice>
          ) : null}
          <p className={styles.range}>
            <SkeletonLine width="24ch" />
          </p>
          <MetricSummaryGridSkeleton />
        </Stack>
      </SectionCard>

      <SectionCard
        id="report-agents"
        title={content.reports.agentsHeading}
        description={content.reports.agentsDescription}
      >
        <Stack gap="3">
          <AgentBreakdownTableSkeleton />
          <p className={styles.note}>{content.reports.mediansDoNotSumNote}</p>
        </Stack>
      </SectionCard>

      <SectionCard
        id="report-series"
        title={content.reports.seriesHeading}
        description={content.reports.seriesDescription}
      >
        <DailyVolumeChartSkeleton />
      </SectionCard>
    </Stack>
  );
}
