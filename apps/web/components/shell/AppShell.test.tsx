import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { content } from '@/content/en';
import { testBranding } from '@/lib/testing/branding';
import { AppShell } from './AppShell';
import { AppSidebar } from './AppSidebar';
import type { NavItem } from './navigation';

vi.mock('next/navigation', () => ({
  usePathname: () => '/inbox',
}));

// The server action only writes the cookie; what this file is about is the
// width the user sees, which changes before the action resolves.
const setRailStateAction = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('./rail.actions', () => ({ setRailStateAction }));

const ITEMS: readonly NavItem[] = [
  { id: 'inbox', label: 'Inbox', href: '/inbox', icon: 'inbox' },
  { id: 'settings', label: 'Settings', href: '/settings', icon: 'settings' },
];

function renderShell(): void {
  render(
    <AppShell
      initialRailState="expanded"
      rail={<AppSidebar items={ITEMS} branding={testBranding()} />}
      bar={null}
    >
      <p>Page</p>
    </AppShell>,
  );
}

describe('AppShell', () => {
  it('reports the rail expanded, pointing at the navigation it controls', () => {
    renderShell();

    const toggle = screen.getByRole('button', { name: content.nav.collapseNav });
    const nav = screen.getByRole('navigation', { name: content.nav.primaryLabel });

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle.getAttribute('aria-controls')).toBe(nav.id);
  });

  it('collapses on click and persists the choice for the next request', () => {
    renderShell();

    fireEvent.click(screen.getByRole('button', { name: content.nav.collapseNav }));

    expect(screen.getByRole('button', { name: content.nav.expandNav })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(setRailStateAction).toHaveBeenCalledWith('collapsed');
  });

  it('keeps every link named while collapsed — the labels leave the eye, not the tree', () => {
    renderShell();

    fireEvent.click(screen.getByRole('button', { name: content.nav.collapseNav }));

    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveAttribute('href', '/inbox');
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('marks the current destination for assistive technology, not by colour alone', () => {
    renderShell();

    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current');
  });
});
