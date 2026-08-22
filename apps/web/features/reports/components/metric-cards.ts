import type { Content } from '@/lib/content';

/**
 * Which figures the overview shows, in order, without their values.
 *
 * The real grid and its skeleton both build from this, which is what keeps the
 * skeleton from drifting: adding a metric changes one array and both stay in
 * step, including which secondary figures each tile reserves room for and
 * whether it carries an info affordance.
 *
 * The order is the order a supervisor reads them in — the three counts say how
 * much work moved, the two durations say how fast. Volume first, because a
 * median over three tickets means something different from a median over three
 * hundred, and the counts are what tell you which you are looking at.
 */

export const METRIC_CARD_KEYS = [
  'created',
  'resolved',
  'closedWithoutResolution',
  'firstResponse',
  'resolution',
] as const;

export type MetricCardKey = (typeof METRIC_CARD_KEYS)[number];

export interface MetricCardMeta {
  readonly key: MetricCardKey;
  readonly label: string;
  /**
   * How the figure is measured. Rendered behind the label's info affordance
   * rather than in the tile body (TAR-519): it is what a supervisor quoting the
   * number needs, and it is not what the tile is for.
   */
  readonly methodology: string;
  /** Names that affordance — "How first response time is measured". */
  readonly methodologyLabel: string;
  /**
   * The secondary figures the tile reserves room for, by their terms: the
   * average, the p90 and the sample size. Empty on the three counts, which have
   * nothing beneath them.
   */
  readonly detailLabels: readonly string[];
}

export function metricCardMeta(content: Content): readonly MetricCardMeta[] {
  const durationDetailLabels = [
    content.reports.statAverage,
    content.reports.statP90,
    content.reports.statSampleLabel,
  ];

  return [
    {
      key: 'created',
      label: content.reports.volumeCreatedLabel,
      methodology: content.reports.volumeCreatedHint,
      methodologyLabel: content.reports.metricInfoLabel(content.reports.volumeCreatedLabel),
      detailLabels: [],
    },
    {
      key: 'resolved',
      label: content.reports.volumeResolvedLabel,
      methodology: content.reports.volumeResolvedHint,
      methodologyLabel: content.reports.metricInfoLabel(content.reports.volumeResolvedLabel),
      detailLabels: [],
    },
    {
      key: 'closedWithoutResolution',
      label: content.reports.volumeClosedUnresolvedLabel,
      methodology: content.reports.volumeClosedUnresolvedHint,
      methodologyLabel: content.reports.metricInfoLabel(
        content.reports.volumeClosedUnresolvedLabel,
      ),
      detailLabels: [],
    },
    {
      key: 'firstResponse',
      label: content.reports.firstResponseLabel,
      methodology: content.reports.firstResponseHint,
      methodologyLabel: content.reports.metricInfoLabel(content.reports.firstResponseLabel),
      detailLabels: durationDetailLabels,
    },
    {
      key: 'resolution',
      label: content.reports.resolutionLabel,
      methodology: content.reports.resolutionHint,
      methodologyLabel: content.reports.metricInfoLabel(content.reports.resolutionLabel),
      detailLabels: durationDetailLabels,
    },
  ];
}
