import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { content } from '@/content/en';
import { MobileMenu } from './MobileMenu';
import type { NavItem } from './navigation';

// `fireEvent` rather than `user-event`: the repo does not carry that package, and
// these assertions are about the component's own focus and ARIA handling.
vi.mock('next/navigation', () => ({
  usePathname: () => '/inbox',
}));

const ITEMS: readonly NavItem[] = [
  { id: 'inbox', label: 'Inbox', href: '/inbox', requiresAny: ['conversation:read'] },
  {
    id: 'settings',
    label: 'Settings',
    href: '/settings',
    requiresAny: ['team:write'],
    children: [
      {
        id: 'settings-people',
        label: 'People',
        href: '/settings/people',
        requiresAny: ['team:write'],
      },
    ],
  },
];

function openMenu(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: content.nav.openMenu }));

  return screen.getByRole('button', { name: content.nav.closeMenu });
}

function panelFor(trigger: HTMLElement): HTMLElement {
  const panel = document.getElementById(trigger.getAttribute('aria-controls') ?? '');

  if (panel === null) {
    throw new Error('The trigger’s aria-controls does not point at an existing node.');
  }

  return panel;
}

describe('MobileMenu', () => {
  it('starts closed, reporting collapsed, with the panel present but inert', () => {
    render(<MobileMenu items={ITEMS} />);

    const trigger = screen.getByRole('button', { name: content.nav.openMenu });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // `aria-controls` must point at a node that exists even while closed.
    expect(panelFor(trigger)).toHaveAttribute('inert');
  });

  it('opens on click, moves focus into the panel and locks background scroll', () => {
    render(<MobileMenu items={ITEMS} />);

    const trigger = openMenu();
    const panel = panelFor(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(document.body).toHaveAttribute('data-scroll-locked', 'true');
    expect(panel).not.toHaveAttribute('inert');
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape, restores focus to the trigger and releases the scroll lock', () => {
    render(<MobileMenu items={ITEMS} />);

    openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });

    const trigger = screen.getByRole('button', { name: content.nav.openMenu });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
    expect(document.body).not.toHaveAttribute('data-scroll-locked');
  });

  it('closes when the trigger is used a second time', () => {
    render(<MobileMenu items={ITEMS} />);

    const trigger = openMenu();
    fireEvent.click(trigger);

    expect(screen.getByRole('button', { name: content.nav.openMenu })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('renders the nested settings links from the same nav data as the desktop nav', () => {
    render(<MobileMenu items={ITEMS} />);

    openMenu();

    expect(screen.getByRole('link', { name: 'People' })).toHaveAttribute(
      'href',
      '/settings/people',
    );
  });
});
