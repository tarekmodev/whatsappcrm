import type { Content } from '@/lib/content';

/**
 * Which figures the overview shows, in order, without their values.
 *
 * The real grid and its skeleton both build from this, which is what keeps the
 * skeleton from drifting: adding a metric changes one array and both stay in
 * step, including how many secondary statistics each card reserves room for.
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
  readonly hint: string;
  /**
   * Secondary statistics the card reserves room for: the average, the p90 and
   * the sample size. Zero on the three counts, which have nothing beneath them.
   */
  readonly detailCount: number;
}

const DURATION_DETAIL_COUNT = 3;

export function metricCardMeta(content: Content): readonly MetricCardMeta[] {
  return [
    {
      key: 'created',
      label: content.reports.volumeCreatedLabel,
      hint: content.reports.volumeCreatedHint,
      detailCount: 0,
    },
    {
      key: 'resolved',
      label: content.reports.volumeResolvedLabel,
      hint: content.reports.volumeResolvedHint,
      detailCount: 0,
    },
    {
      key: 'closedWithoutResolution',
      label: content.reports.volumeClosedUnresolvedLabel,
      hint: content.reports.volumeClosedUnresolvedHint,
      detailCount: 0,
    },
    {
      key: 'firstResponse',
      label: content.reports.firstResponseLabel,
      hint: content.reports.firstResponseHint,
      detailCount: DURATION_DETAIL_COUNT,
    },
    {
      key: 'resolution',
      label: content.reports.resolutionLabel,
      hint: content.reports.resolutionHint,
      detailCount: DURATION_DETAIL_COUNT,
    },
  ];
}
