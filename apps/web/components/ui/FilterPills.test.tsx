import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FilterPills, type FilterPillItem } from './FilterPills';

const ITEMS: readonly FilterPillItem[] = [
  { id: 'assigned', label: 'Assigned to me', href: '/inbox?scope=assigned', isCurrent: true },
  { id: 'all', label: 'All conversations', href: '/inbox?scope=all', isCurrent: false },
];

describe('FilterPills', () => {
  it('names the strip for assistive technology', () => {
    render(<FilterPills label="Conversation scope" items={ITEMS} />);

    expect(screen.getByRole('navigation', { name: 'Conversation scope' })).toBeInTheDocument();
  });

  it('marks the current filter with aria-current and leaves the rest unmarked', () => {
    render(<FilterPills label="Conversation scope" items={ITEMS} />);

    expect(screen.getByRole('link', { name: 'Assigned to me' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'All conversations' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('keeps the filter in the href, so the back button reproduces the view', () => {
    render(<FilterPills label="Conversation scope" items={ITEMS} />);

    expect(screen.getByRole('link', { name: 'All conversations' })).toHaveAttribute(
      'href',
      '/inbox?scope=all',
    );
  });

  it('renders nothing when there is only one choice', () => {
    const { container } = render(
      <FilterPills label="Conversation scope" items={[ITEMS[0] as FilterPillItem]} />,
    );

    // A filter offering no choice is not a filter, and one dead pill reads as a
    // broken control.
    expect(container).toBeEmptyDOMElement();
  });
});
