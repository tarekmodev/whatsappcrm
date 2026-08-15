import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AgentReportRow, DurationStats } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { AgentBreakdownTable, AgentBreakdownTableSkeleton } from './AgentBreakdownTable';

/**
 * TAR-30's first acceptance criterion at the row level: the per-agent breakdown
 * is a real table a supervisor can read, not a tenant-wide total.
 *
 * Queried by role and text rather than by class, so these assert what a person —
 * or a screen reader — actually gets.
 */

function stats(overrides: Partial<DurationStats> = {}): DurationStats {
  return { count: 2, averageSeconds: 900, medianSeconds: 8040, p90Seconds: 9300, ...overrides };
}

const EMPTY_STATS: DurationStats = {
  count: 0,
  averageSeconds: null,
  medianSeconds: null,
  p90Seconds: null,
};

function row(overrides: Partial<AgentReportRow> = {}): AgentReportRow {
  return {
    userId: '0192f001-0000-7000-8000-000000000101',
    name: 'Amina Haddad',
    isActive: true,
    ticketsResolved: 3,
    firstResponse: stats(),
    resolution: stats({ medianSeconds: 367_200 }),
    ...overrides,
  };
}

describe('the per-agent breakdown', () => {
  it('gives the table an accessible name and one row per agent', () => {
    render(
      <AgentBreakdownTable
        rows={[row(), row({ userId: '0192f001-0000-7000-8000-000000000102', name: 'Priya Raman' })]}
      />,
    );

    expect(screen.getByRole('table', { name: content.reports.agentsHeading })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Amina Haddad' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Priya Raman' })).toBeInTheDocument();
  });

  it('renders durations through the console’s one formatter', () => {
    render(<AgentBreakdownTable rows={[row()]} />);

    // 8040 seconds is the ADR's own example, and 367,200 is a realistic
    // multi-day resolution. Both read as cycle times rather than as raw seconds.
    expect(screen.getByRole('cell', { name: '2h 14m' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '4d 6h' })).toBeInTheDocument();
  });

  it('says "No data" where nothing was measured, rather than showing a zero', () => {
    render(<AgentBreakdownTable rows={[row({ resolution: EMPTY_STATS })]} />);

    // A quiet week must not read as an instant resolution.
    expect(screen.getByRole('cell', { name: content.reports.noMeasurement })).toBeInTheDocument();
  });

  it('names the unattributed row and explains it, so the table adds up', () => {
    render(
      <AgentBreakdownTable rows={[row(), row({ userId: null, name: null, isActive: false })]} />,
    );

    expect(screen.getByText(content.reports.unattributed)).toBeInTheDocument();
    expect(screen.getByText(content.reports.unattributedHint)).toBeInTheDocument();
    // It is work with no owner, not a departed colleague — so it must not be
    // labelled as one.
    expect(screen.queryByText(content.reports.inactiveAgent)).not.toBeInTheDocument();
  });

  it('keeps a departed agent’s numbers in a closed period, and says why they are there', () => {
    render(<AgentBreakdownTable rows={[row({ isActive: false })]} />);

    expect(screen.getByText(content.reports.inactiveAgent)).toBeInTheDocument();
  });

  it('explains an empty range instead of rendering a blank panel', () => {
    render(<AgentBreakdownTable rows={[]} />);

    expect(screen.getByText(content.reports.agentsEmptyHeading)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('its skeleton', () => {
  it('announces itself once, politely, instead of reading out its placeholders', () => {
    render(<AgentBreakdownTableSkeleton />);

    expect(screen.getByRole('status')).toHaveTextContent(content.reports.agentsLoading);
    // The placeholder table is `aria-hidden`, so a screen reader hears one
    // sentence rather than four columns of nothing. That is also why the columns
    // below are read from the DOM rather than by role.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('draws the same columns, in the same order, as the loaded table', () => {
    const { container, rerender } = render(<AgentBreakdownTableSkeleton />);
    const headersWhileLoading = headerText(container);

    rerender(<AgentBreakdownTable rows={[row()]} />);

    // Identical headers are what make the swap from skeleton to data produce no
    // layout shift — the two build from one column definition, and this is the
    // assertion that fails if somebody adds a column to only one of them.
    expect(headersWhileLoading).toEqual(headerText(container));
    expect(headersWhileLoading).toContain(content.reports.columnFirstResponse);
  });
});

function headerText(container: HTMLElement): string[] {
  return [...container.querySelectorAll('th')].map((cell) => cell.textContent ?? '');
}
