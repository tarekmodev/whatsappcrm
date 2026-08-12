import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NavLinkList } from './NavLinkList';
import type { NavItem } from './navigation';

vi.mock('next/navigation', () => ({
  usePathname: () => '/inbox',
}));

const ITEMS: readonly NavItem[] = [
  { id: 'inbox', label: 'Inbox', href: '/inbox', icon: 'inbox' },
  { id: 'settings', label: 'Settings', href: '/settings', icon: 'settings' },
  { id: 'security', label: 'Security', href: '/settings/security', icon: 'security' },
];

/**
 * The rail's More/Less boundary. The rule that matters is the one that keeps it
 * from being noise: a list short enough to show whole grows no control saying so.
 */
describe('NavLinkList', () => {
  it('marks the current entry', () => {
    render(<NavLinkList items={ITEMS} />);

    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current');
  });

  it('renders no boundary when every entry fits', () => {
    render(<NavLinkList items={ITEMS} primaryCount={ITEMS.length} />);

    expect(screen.queryByRole('button', { name: /more/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Security' })).toBeInTheDocument();
  });

  it('hides the entries past the boundary until More is pressed', () => {
    render(<NavLinkList items={ITEMS} primaryCount={1} />);

    expect(screen.getByRole('link', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();

    const more = screen.getByRole('button', { name: 'More' });

    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);

    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the links named when the rail is collapsed', () => {
    // Collapsed hides the labels from the eye only. A link whose text was
    // dropped is a link with no accessible name.
    render(<NavLinkList items={ITEMS} appearance="rail" isCollapsed primaryCount={1} />);

    expect(screen.getByRole('link', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveAttribute('title', 'Inbox');
  });
});
