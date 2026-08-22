import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActiveFilterChips, type ActiveFilterChip } from './ActiveFilterChips';

/**
 * The strip only exists to answer "narrowed by what?" for filters that are no
 * longer on screen. Its two rules are that each chip clears exactly itself, and
 * that nothing is rendered when nothing is on.
 */
describe('ActiveFilterChips', () => {
  const CHIPS: ActiveFilterChip[] = [
    { id: 'status', group: 'Status', value: 'Resolved', clearHref: '/tickets?scope=all' },
    {
      id: 'priority',
      group: 'Priority',
      value: 'Urgent',
      clearHref: '/tickets?scope=all&status=resolved',
    },
  ];

  it('renders nothing when nothing is filtered', () => {
    const { container } = render(<ActiveFilterChips label="Active filters" items={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('says which filter each chip removes, not where it leads', () => {
    render(<ActiveFilterChips label="Active filters" items={CHIPS} />);

    const chip = screen.getByRole('link', { name: 'Clear Status: Resolved' });

    expect(chip).toHaveAttribute('href', '/tickets?scope=all');
    expect(chip).toHaveTextContent('Status: Resolved');
  });

  it('offers to clear everything only once there is more than one chip', () => {
    const { rerender } = render(
      <ActiveFilterChips label="Active filters" items={CHIPS} clearAllHref="/tickets" />,
    );

    expect(screen.getByRole('link', { name: 'Clear all' })).toBeInTheDocument();

    rerender(
      <ActiveFilterChips
        label="Active filters"
        items={CHIPS.slice(0, 1)}
        clearAllHref="/tickets"
      />,
    );

    expect(screen.queryByRole('link', { name: 'Clear all' })).not.toBeInTheDocument();
  });
});
