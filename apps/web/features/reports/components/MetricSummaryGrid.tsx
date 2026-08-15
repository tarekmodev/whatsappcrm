import type { DurationStats, ReportMetrics } from '@whatsappcrm/contracts';
import { AutoGrid } from '@/components/layout/AutoGrid';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { content } from '@/content/en';
import { METRIC_CARD_MIN_WIDTH } from '@/features/reports/constants';
import { formatCount, formatDuration } from '@/features/reports/presentation';
import { MetricCard, MetricCardSkeleton, type MetricCardDetail } from './MetricCard';
import { metricCardMeta, type MetricCardKey } from './metric-cards';

/**
 * The five headline figures. Usage: `<MetricSummaryGrid metrics={summary} />`.
 *
 * A server component: five formatted strings in an auto-fitting grid, with
 * nothing to hydrate. `AutoGrid` gives it a column count from `auto-fit` rather
 * than from breakpoints, so it reflows continuously from one card wide at 320px
 * to five across on a desktop.
 *
 * The three counts and the two durations are the same card deliberately. They
 * are read together — a median over three tickets means something very different
 * from a median over three hundred — and giving durations their own visual
 * treatment would suggest they are a different kind of claim.
 */
export function MetricSummaryGrid({ metrics }: { metrics: ReportMetrics }) {
  return (
    <AutoGrid minItemWidth={METRIC_CARD_MIN_WIDTH} gap="3">
      {metricCardMeta(content).map((meta) => (
        <MetricCard
          key={meta.key}
          label={meta.label}
          hint={meta.hint}
          value={valueFor(meta.key, metrics)}
          details={detailsFor(meta.key, metrics)}
        />
      ))}
    </AutoGrid>
  );
}

/**
 * Mirrors the loaded grid exactly — the same five cards, the same labels and
 * hints, the same reserved detail rows — so the swap shifts nothing.
 */
export function MetricSummaryGridSkeleton() {
  return (
    <>
      <LoadingAnnouncement label={content.reports.summaryLoading} />
      <AutoGrid minItemWidth={METRIC_CARD_MIN_WIDTH} gap="3">
        {metricCardMeta(content).map((meta) => (
          <MetricCardSkeleton
            key={meta.key}
            label={meta.label}
            hint={meta.hint}
            detailCount={meta.detailCount}
          />
        ))}
      </AutoGrid>
    </>
  );
}

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
      value: formatDuration(stats.averageSeconds, content),
    },
    {
      id: 'p90',
      label: content.reports.statP90,
      value: formatDuration(stats.p90Seconds, content),
    },
    {
      id: 'sample',
      label: content.reports.statSampleLabel,
      value: formatCount(stats.count, content),
    },
  ];
}
