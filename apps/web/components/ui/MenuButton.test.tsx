import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MenuButton } from './MenuButton';

vi.mock('next/navigation', () => ({
  usePathname: () => '/inbox',
}));

/**
 * The behaviour a popup has to get right whatever is inside it: the disclosure
 * contract on the trigger, focus in and back out, and the two ways a menu is
 * dismissed without choosing anything.
 */
describe('MenuButton', () => {
  function renderMenu() {
    render(
      <>
        <MenuButton label="Create" accessibleName="Create">
          <ul>
            <li>
              <a href="/settings/people">Invite a teammate</a>
            </li>
          </ul>
        </MenuButton>
        <button>Somewhere else</button>
      </>,
    );

    return screen.getByRole('button', { name: 'Create' });
  }

  it('is a collapsed disclosure until it is pressed', () => {
    const trigger = renderMenu();

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Invite a teammate' })).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Invite a teammate' })).toBeInTheDocument();
  });

  it('moves focus into the panel on open and back to the trigger on Escape', () => {
    const trigger = renderMenu();

    fireEvent.click(trigger);
    expect(screen.getByRole('link', { name: 'Invite a teammate' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('closes on a press outside itself, and stays open on one inside', () => {
    const trigger = renderMenu();

    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole('link', { name: 'Invite a teammate' }));
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Somewhere else' }));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('always has the element its aria-controls names', () => {
    // A disclosure pointing at an id that is not in the document is a broken
    // relationship, so the closed state keeps an empty target rather than none.
    const trigger = renderMenu();
    const panelId = trigger.getAttribute('aria-controls');

    expect(panelId).not.toBeNull();
    expect(document.getElementById(panelId ?? '')).not.toBeNull();
  });
});
