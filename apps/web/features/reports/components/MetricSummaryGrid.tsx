import type { DurationStats, ReportMetrics } from '@whatsappcrm/contracts';
import { AutoGrid } from '@/components/layout/AutoGrid';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { content } from '@/content/en';
import { METRIC_CARD_MIN_WIDTH } from '@/features/reports/constants';
import { formatCount, formatDuration } from '@/features/reports/presentation';
import { MeasuredDuration } from './MeasuredDuration';
import { MetricCard, MetricCardSkeleton, type MetricCardDetail } from './MetricCard';
import { metricCardMeta, type MetricCardKey } from './metric-cards';

/**
 * The five headline figures. Usage: `<MetricSummaryGrid metrics={summary} />`.
 *
 * A server component: five formatted strings in an auto-fitting grid, with only
 * the info affordances hydrating. `AutoGrid` gives it a column count from
 * `auto-fit` rather than from breakpoints, so it reflows continuously from one
 * tile wide at 320px to five across on a desktop.
 *
 * `align="start"`, so the three tiles with no secondary figures are exactly as
 * tall as they need to be. Stretching them to match the two that carry a detail
 * list is what put a hundred pixels of nothing in each of them (TAR-519).
 *
 * The three counts and the two durations are the same tile deliberately. They
 * are read together — a median over three tickets means something very different
 * from a median over three hundred — and giving durations their own visual
 * treatment would suggest they are a different kind of claim.
 */
export function MetricSummaryGrid({ metrics }: { metrics: ReportMetrics }) {
  return (
    <AutoGrid minItemWidth={METRIC_CARD_MIN_WIDTH} gap="3" align="start">
      {metricCardMeta(content).map((meta) => (
        <MetricCard
          key={meta.key}
          label={meta.label}
          methodology={meta.methodology}
          methodologyLabel={meta.methodologyLabel}
          value={valueFor(meta.key, metrics)}
          details={detailsFor(meta.key, metrics)}
        />
      ))}
    </AutoGrid>
  );
}

/**
 * Mirrors the loaded grid exactly — the same five tiles, the same labels,
 * methodology and detail terms, the same alignment — so the swap shifts nothing.
 */
export function MetricSummaryGridSkeleton() {
  return (
    <>
      <LoadingAnnouncement label={content.reports.summaryLoading} />
      <AutoGrid minItemWidth={METRIC_CARD_MIN_WIDTH} gap="3" align="start">
        {metricCardMeta(content).map((meta) => (
          <MetricCardSkeleton
            key={meta.key}
            label={meta.label}
            methodology={meta.methodology}
            methodologyLabel={meta.methodologyLabel}
            detailLabels={meta.detailLabels}
          />
        ))}
      </AutoGrid>
    </>
  );
}

/**
 * The hero figure keeps the **words** for an absent duration rather than the
 * dash `MeasuredDuration` draws: here the absence is the answer to the question
 * the tile asks, and a dash as the largest thing in a card says nothing.
 */
function valueFor(key: MetricCardKey, metrics: ReportMetrics): string {
  switch (key) {
    case 'created':
      return formatCount(metrics.volume.created, content);
    case 'resolved':
      return formatCount(metrics.volume.resolved, content);
    case 'closedWithoutResolution':
      return formatCount(metrics.volume.closedWithoutResolution, content);
    case 'firstResponse':
      return formatDuration(metrics.firstResponse.medianSeconds, content);
    case 'resolution':
      return formatDuration(metrics.resolution.medianSeconds, content);
  }
}

/**
 * A count has nothing beneath it; a duration has the three statistics that say
 * how much to trust the median above.
 */
function detailsFor(key: MetricCardKey, metrics: ReportMetrics): readonly MetricCardDetail[] {
  switch (key) {
    case 'firstResponse':
      return durationDetails(metrics.firstResponse);
    case 'resolution':
      return durationDetails(metrics.resolution);
    default:
      return [];
  }
}

function durationDetails(stats: DurationStats): readonly MetricCardDetail[] {
  return [
    {
      id: 'average',
      label: content.reports.statAverage,
      value: <MeasuredDuration seconds={stats.averageSeconds} />,
    },
    {
      id: 'p90',
      label: content.reports.statP90,
      value: <MeasuredDuration seconds={stats.p90Seconds} />,
    },
    {
      id: 'sample',
      label: content.reports.statSampleLabel,
      value: formatCount(stats.count, content),
    },
  ];
}
