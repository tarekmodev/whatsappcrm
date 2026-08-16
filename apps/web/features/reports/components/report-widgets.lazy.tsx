'use client';

import dynamic from 'next/dynamic';
import { DailyVolumeChartSkeleton } from './DailyVolumeChart.Skeleton';

/**
 * The daily-volume chart, in a chunk of its own.
 *
 * It sits below both the headline figures and the per-agent table on every
 * viewport this app supports, it is not the LCP element, and it is the one part
 * of this screen a supervisor can answer their question without — so its
 * JavaScript has no business in the initial route bundle. The boundary's fallback
 * is the chart's own skeleton, sized identically, so deferring the chunk cannot
 * shift the layout.
 *
 * SSR stays on: the chart is reporting data that belongs in the first HTML
 * response, and turning it off would leave a gap until hydration for no benefit —
 * the component has no browser API to wait for.
 */

export const LazyDailyVolumeChart = dynamic(
  async () => (await import('./DailyVolumeChart')).DailyVolumeChart,
  { loading: () => <DailyVolumeChartSkeleton /> },
);
