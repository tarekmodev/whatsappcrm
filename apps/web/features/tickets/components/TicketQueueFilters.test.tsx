import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TicketQueueFilters } from './TicketQueueFilters';
import type { TicketQueueParams } from '@/features/tickets/ticket-params';

vi.mock('next/navigation', () => ({
  usePathname: () => '/tickets',
}));

/**
 * 0001's filter row on the screen that needed it most: four groups, one visible.
 * What is verified here is the rule, not the pills — `FilterPills` has its own
 * test and this one would only repeat it.
 */
describe('TicketQueueFilters', () => {
  const DEFAULT: TicketQueueParams = {
    scope: 'assigned',
    status: undefined,
    priority: undefined,
    isOverdueOnly: false,
  };

  function renderFilters(params: Partial<TicketQueueParams> = {}) {
    render(<TicketQueueFilters params={{ ...DEFAULT, ...params }} canReadAll />);
  }

  it('shows the scope and hides the other three groups behind one trigger', () => {
    renderFilters();

    expect(screen.getByRole('link', { name: 'Unassigned' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Resolved' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));

    expect(screen.getByRole('link', { name: 'Resolved' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Urgent' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overdue' })).toBeInTheDocument();
  });

  it('counts the hidden filters that are on, and never the scope', () => {
    renderFilters({ scope: 'all', status: 'resolved', isOverdueOnly: true });

    expect(screen.getByRole('button', { name: 'Filters, 2 applied' })).toBeInTheDocument();
  });

  it('names each hidden filter in a chip that clears only itself', () => {
    renderFilters({ status: 'resolved', priority: 'urgent' });

    expect(screen.getByRole('link', { name: 'Clear Status: Resolved' })).toHaveAttribute(
      'href',
      '/tickets?scope=assigned&priority=urgent',
    );
    expect(screen.getByRole('link', { name: 'Clear Priority: Urgent' })).toHaveAttribute(
      'href',
      '/tickets?scope=assigned&status=resolved',
    );
  });

  it('keeps the scope when everything else is cleared at once', () => {
    renderFilters({ scope: 'all', status: 'resolved', priority: 'urgent' });

    expect(screen.getByRole('link', { name: 'Clear all' })).toHaveAttribute(
      'href',
      '/tickets?scope=all',
    );
  });

  it('shows no chips and no count when the queue is unfiltered', () => {
    renderFilters();

    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Active filters' })).not.toBeInTheDocument();
  });
});
