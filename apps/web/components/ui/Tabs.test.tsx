import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Tabs, type TabItem } from './Tabs';

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/people',
}));

const ITEMS: readonly TabItem[] = [
  { id: 'people', label: 'People', href: '/settings/people' },
  { id: 'security', label: 'Security', href: '/settings/security' },
  // A tab whose href carries a default filter: the query must not stop it
  // being recognised as the current one.
  { id: 'assignment', label: 'Assignment', href: '/settings/assignment?tab=agents' },
];

describe('Tabs', () => {
  it('names the strip for assistive technology', () => {
    render(<Tabs label="Settings sections" items={ITEMS} />);

    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument();
  });

  it('renders every tab as a real link, so a tab is shareable and middle-clickable', () => {
    render(<Tabs label="Settings sections" items={ITEMS} />);

    expect(screen.getByRole('link', { name: 'Security' })).toHaveAttribute(
      'href',
      '/settings/security',
    );
  });

  it('marks only the current tab with aria-current', () => {
    render(<Tabs label="Settings sections" items={ITEMS} />);

    expect(screen.getByRole('link', { name: 'People' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Security' })).not.toHaveAttribute('aria-current');
  });
});
