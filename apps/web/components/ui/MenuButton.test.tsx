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

  it('will not open while it is disabled', () => {
    render(
      <MenuButton label="Create" accessibleName="Create" isDisabled>
        <a href="/settings/people">Invite a teammate</a>
      </MenuButton>,
    );

    const trigger = screen.getByRole('button', { name: 'Create' });

    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Invite a teammate' })).not.toBeInTheDocument();
  });

  it('takes a dismissed panel out of the tab order before it has finished leaving', () => {
    // jsdom runs no transitions, so the panel unmounts on the fallback path in
    // `useExitTransition` — what this pins is that nothing focusable is left
    // behind either way.
    const trigger = renderMenu();

    fireEvent.click(trigger);
    expect(screen.getByRole('link', { name: 'Invite a teammate' })).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.queryByRole('link', { name: 'Invite a teammate' })).not.toBeInTheDocument();
  });
});

/**
 * Keeping the panel on screen. jsdom lays nothing out — every box is 0×0 — so
 * these stub `getBoundingClientRect` to place the panel where a real browser
 * would, and assert on the custom property the module CSS translates by.
 *
 * The bug being pinned: below the layout breakpoint the top bar's controls wrap
 * to their own line at the inline start, so a panel anchored to a trigger's *end*
 * edge grows off the side of the screen — and overflow past the inline start
 * produces no scrollbar, so it reads as a panel that lost half its contents.
 */
describe('MenuButton — staying inside the viewport', () => {
  function openWithPanelAt(left: number, width: number, viewportWidth: number): HTMLElement {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(viewportWidth);

    render(
      <MenuButton label="Alerts" accessibleName="Alerts">
        <p>Nothing overdue</p>
      </MenuButton>,
    );

    const trigger = screen.getByRole('button', { name: 'Alerts' });
    const panelId = trigger.getAttribute('aria-controls') ?? '';

    // Stubbed before the click, so the layout effect measures these on open.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: left,
      y: 0,
      left,
      right: left + width,
      top: 0,
      bottom: 0,
      width,
      height: 0,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);

    const panel = document.getElementById(panelId);

    if (panel === null) {
      throw new Error('The panel did not open.');
    }

    return panel;
  }

  it('pushes a panel that opened off the inline start back into view', () => {
    // 320px phone, bell near the left, 288px panel anchored to its end edge.
    const panel = openWithPanelAt(-224, 288, 320);

    // 8px margin - (-224px) = 232px right.
    expect(panel.style.getPropertyValue('--menu-shift')).toBe('232px');
  });

  it('pulls a panel that overhangs the inline end back inside', () => {
    const panel = openWithPanelAt(1200, 370, 1440);

    // Right edge 1570 against a 1432px limit: 138px left.
    expect(panel.style.getPropertyValue('--menu-shift')).toBe('-138px');
  });

  it('leaves a panel that already fits exactly where the CSS put it', () => {
    const panel = openWithPanelAt(818, 370, 1440);

    expect(panel.style.getPropertyValue('--menu-shift')).toBe('0px');
  });

  it('measures the space the panel can use, not the space the scrollbar takes', () => {
    // `window.innerWidth` counts a classic scrollbar; `clientWidth` does not. A
    // panel ending at 1435 fits a 1440px window and overhangs a 1425px viewport.
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440);

    const panel = openWithPanelAt(1065, 370, 1425);

    expect(panel.style.getPropertyValue('--menu-shift')).toBe('-18px');
  });
});
