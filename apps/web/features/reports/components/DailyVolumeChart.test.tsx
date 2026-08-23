import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { DailyPoint } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { DailyVolumeChart } from './DailyVolumeChart';
import { DailyVolumeChartSkeleton } from './DailyVolumeChart.Skeleton';

/**
 * TAR-519's chart criteria, asserted the way a person meets them: the axes are
 * readable, every day is reachable without a pointer, and the figures a tooltip
 * shows are also figures a screen reader is given.
 */

function point(overrides: Partial<DailyPoint> & { date: string }): DailyPoint {
  return { created: 0, resolved: 0, firstResponseMedianSeconds: null, ...overrides };
}

const SERIES: readonly DailyPoint[] = [
  point({ date: '2026-08-17', created: 4, resolved: 2, firstResponseMedianSeconds: 2400 }),
  point({ date: '2026-08-18', created: 0, resolved: 0 }),
  point({ date: '2026-08-19', created: 9, resolved: 7 }),
];

describe('the daily-volume chart', () => {
  it('gives every day its own figures, as text', () => {
    render(<DailyVolumeChart series={SERIES} />);

    // The busiest day, read out in full — including the median first response,
    // which the contract has carried per day since TAR-428 and nothing drew.
    expect(
      screen.getByRole('img', { name: /17 Aug: 4 opened, 2 resolved, median first response 40m/ }),
    ).toBeInTheDocument();
    // And the quiet one, which must read as measured rather than as missing.
    expect(screen.getByRole('img', { name: /18 Aug: 0 opened, 0 resolved/ })).toBeInTheDocument();
  });

  it('labels its value axis, so a bar’s height means something', () => {
    render(<DailyVolumeChart series={SERIES} />);

    // A peak of nine gives a ceiling of ten in steps of five.
    expect(screen.getByText(content.reports.seriesValueAxisLabel)).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('dates its columns rather than only the ends of the range', () => {
    render(<DailyVolumeChart series={SERIES} />);

    // Three days, so every one of them is labelled.
    for (const label of ['17 Aug', '18 Aug', '19 Aug']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('is one tab stop, and the arrow keys move between the days inside it', () => {
    render(<DailyVolumeChart series={SERIES} />);

    const days = screen.getAllByRole('img');

    expect(days[0]).toHaveAttribute('tabindex', '0');
    expect(days[1]).toHaveAttribute('tabindex', '-1');

    days[0]?.focus();
    fireEvent.keyDown(days[0] as HTMLElement, { key: 'ArrowRight' });

    expect(days[1]).toHaveFocus();
    expect(days[1]).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(days[1] as HTMLElement, { key: 'End' });

    expect(days.at(-1)).toHaveFocus();
  });

  /*
   * TAR-806. The days run along the reading direction, so under `dir="rtl"` the
   * column to the *left* of today is tomorrow. Before this, `ArrowRight` was
   * pinned to +1 and walked an Arabic reader backwards through their own chart.
   */
  it('follows the reading direction under RTL', () => {
    document.documentElement.setAttribute('dir', 'rtl');

    try {
      render(<DailyVolumeChart series={SERIES} />);

      const days = screen.getAllByRole('img');

      days[0]?.focus();
      fireEvent.keyDown(days[0] as HTMLElement, { key: 'ArrowLeft' });

      // Left is *forward* here, so it lands on the second day rather than
      // stopping dead against the start of the range.
      expect(days[1]).toHaveFocus();

      fireEvent.keyDown(days[1] as HTMLElement, { key: 'ArrowRight' });

      expect(days[0]).toHaveFocus();
    } finally {
      document.documentElement.removeAttribute('dir');
    }
  });

  it('stops at the ends of the range rather than wrapping round it', () => {
    render(<DailyVolumeChart series={SERIES} />);

    const days = screen.getAllByRole('img');

    days[0]?.focus();
    fireEvent.keyDown(days[0] as HTMLElement, { key: 'ArrowLeft' });

    // A range has a first day. Wrapping to the last one would read as the chart
    // scrolling somewhere unrelated.
    expect(days[0]).toHaveFocus();
  });

  it('shows the focused day’s figures, and takes them away again', () => {
    render(<DailyVolumeChart series={SERIES} />);

    const days = screen.getAllByRole('img');

    expect(screen.queryByText(content.reports.seriesResponseLabel)).not.toBeInTheDocument();

    fireEvent.focus(days[0] as HTMLElement);

    expect(screen.getByText(content.reports.seriesResponseLabel)).toBeInTheDocument();
    expect(screen.getByText('40m')).toBeInTheDocument();

    fireEvent.blur(days[0] as HTMLElement);

    expect(screen.queryByText(content.reports.seriesResponseLabel)).not.toBeInTheDocument();
  });

  it('shows a hovered day’s figures without stealing the tab stop', () => {
    render(<DailyVolumeChart series={SERIES} />);

    const days = screen.getAllByRole('img');

    fireEvent.mouseEnter(days[2] as HTMLElement);

    // The readout, not the axis label of the same date beneath it.
    expect(screen.getByText(content.reports.seriesResponseLabel)).toBeInTheDocument();
    expect(screen.getAllByText('19 Aug').length).toBe(2);
    // Hovering is not focusing: a keyboard user's place in the chart is theirs.
    expect(days[0]).toHaveAttribute('tabindex', '0');
  });

  it('tells a keyboard user the days are reachable', () => {
    render(<DailyVolumeChart series={SERIES} />);

    expect(screen.getByText(content.reports.seriesKeyboardHint)).toBeInTheDocument();
  });

  it('explains an empty range instead of drawing an empty track', () => {
    render(<DailyVolumeChart series={[point({ date: '2026-08-17' })]} />);

    expect(screen.getByText(content.reports.seriesEmptyHeading)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('its skeleton', () => {
  it('announces itself once, politely, instead of reading out its placeholders', () => {
    render(<DailyVolumeChartSkeleton />);

    expect(screen.getByRole('status')).toHaveTextContent(content.reports.seriesLoading);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('draws the same frame as the loaded chart, so the swap shifts nothing', () => {
    const { container, rerender } = render(<DailyVolumeChartSkeleton />);
    const whileLoading = frameOf(container);

    rerender(<DailyVolumeChart series={SERIES} />);

    // The legend, the axis gutter, the track and the day-axis row — the parts
    // whose absence would move the figures when they arrive.
    expect(whileLoading).toEqual(frameOf(container));
  });

  it('reserves the day-axis row, which a placeholder without it would be short by', () => {
    const { container, rerender } = render(<DailyVolumeChartSkeleton />);

    expect(container.querySelectorAll('[class*="dayAxisCell"]').length).toBeGreaterThan(0);

    rerender(<DailyVolumeChart series={SERIES} />);

    expect(container.querySelectorAll('[class*="dayAxisCell"]').length).toBeGreaterThan(0);
  });
});

/**
 * The chart's structural parts, by the classes both renderings share.
 *
 * Deliberately the parts there is exactly one of. The day axis is checked
 * separately: a placeholder cannot know how many days a range has, so its cell
 * count differs by design while its height does not.
 */
function frameOf(container: HTMLElement): number[] {
  return ['legend', 'plot', 'valueAxis', 'scroller', 'days'].map(
    (part) => container.querySelectorAll(`[class*="${part}"]`).length,
  );
}
