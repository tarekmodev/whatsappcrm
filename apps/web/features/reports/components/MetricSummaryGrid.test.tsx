import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReportMetrics } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { MetricSummaryGrid, MetricSummaryGridSkeleton } from './MetricSummaryGrid';
import { metricCardMeta } from './metric-cards';

vi.mock('next/navigation', () => ({
  usePathname: () => '/reports',
}));

/**
 * TAR-519's first two acceptance criteria at the tile level: one anatomy across
 * the row, and the methodology reachable rather than resident.
 */

const METRICS: ReportMetrics = {
  volume: { created: 9, resolved: 7, closedWithoutResolution: 2 },
  firstResponse: { count: 6, averageSeconds: 3000, medianSeconds: 2400, p90Seconds: 9000 },
  resolution: { count: 4, averageSeconds: 90_000, medianSeconds: 86_400, p90Seconds: 120_000 },
};

describe('the overview row', () => {
  it('gives every tile the same anatomy: a label, a figure, and nothing else to read', () => {
    const { container } = render(<MetricSummaryGrid metrics={METRICS} />);

    // The prose that used to sit under every figure is gone from the tiles. If
    // it comes back, this is the assertion that says so.
    for (const meta of metricCardMeta(content)) {
      expect(screen.queryByText(meta.methodology)).not.toBeInTheDocument();
    }

    expect(container.querySelectorAll('dt').length).toBeGreaterThan(0);
  });

  it('renders each figure beside its own label', () => {
    render(<MetricSummaryGrid metrics={METRICS} />);

    expect(screen.getByText(content.reports.volumeCreatedLabel)).toBeInTheDocument();
    // 2400 seconds is 40 minutes; 86,400 is a day. Both through the one formatter.
    expect(screen.getByText('40m')).toBeInTheDocument();
    expect(screen.getByText('1d')).toBeInTheDocument();
  });

  it('puts the methodology behind the label’s info control, reachable by keyboard', () => {
    render(<MetricSummaryGrid metrics={METRICS} />);

    const trigger = screen.getByRole('button', {
      name: content.reports.metricInfoLabel(content.reports.firstResponseLabel),
    });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);

    const explanation = screen.getByText(content.reports.firstResponseHint);

    expect(explanation).toBeInTheDocument();
    // Focus lands on the explanation, which is what makes it read out rather
    // than merely exist; Escape hands focus back.
    expect(explanation).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByText(content.reports.firstResponseHint)).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('marks an unmeasured secondary figure quietly, and still says so out loud', () => {
    render(
      <MetricSummaryGrid
        metrics={{
          ...METRICS,
          resolution: { count: 0, averageSeconds: null, medianSeconds: null, p90Seconds: null },
        }}
      />,
    );

    // The em dash is decoration; the words are what a screen reader gets, and
    // they are still there.
    expect(screen.getAllByText(content.reports.noMeasurement).length).toBeGreaterThan(0);
  });
});

describe('its skeleton', () => {
  it('announces itself once, politely', () => {
    render(<MetricSummaryGridSkeleton />);

    expect(screen.getByRole('status')).toHaveTextContent(content.reports.summaryLoading);
  });

  it('draws the same labels and detail terms as the loaded row, so nothing shifts', () => {
    const { container, rerender } = render(<MetricSummaryGridSkeleton />);
    const whileLoading = termText(container);

    rerender(<MetricSummaryGrid metrics={METRICS} />);

    expect(whileLoading).toEqual(termText(container));
  });
});

/** Every `<dt>`'s text: the labels and the detail terms, in document order. */
function termText(container: HTMLElement): string[] {
  return [...container.querySelectorAll('dt')].map((term) =>
    within(term).queryAllByRole('button').length > 0
      ? (term.firstElementChild?.textContent ?? '')
      : (term.textContent ?? ''),
  );
}
