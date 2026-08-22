import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { content } from '@/content/en';
import { TopBarSearch } from './TopBarSearch';

/**
 * The disclosure, not the search. What the term does to the URL is
 * `routes.inbox`'s job and is covered there; these cases are about the thing
 * TAR-522 added — a field that is behind an icon below the layout breakpoint,
 * and the focus that has to follow it in both directions.
 *
 * `fireEvent` rather than `user-event`: the repo does not carry that package.
 */

const push = vi.fn();
let params = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => params,
}));

beforeEach(() => {
  push.mockClear();
  params = new URLSearchParams();
});

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: content.search.label });
}

describe('TopBarSearch', () => {
  it('starts collapsed, reporting a field that exists to be expanded into', () => {
    render(<TopBarSearch />);

    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    // `aria-controls` must point at a node that exists even while collapsed.
    expect(document.getElementById(trigger().getAttribute('aria-controls') ?? '')).not.toBeNull();
  });

  it('expands on activation and moves focus into the field', () => {
    render(<TopBarSearch />);

    fireEvent.click(trigger());

    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('searchbox', { name: content.search.label })).toHaveFocus();
  });

  it('collapses on Escape and returns focus to the trigger', () => {
    render(<TopBarSearch />);

    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole('searchbox', { name: content.search.label }), {
      key: 'Escape',
    });

    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveFocus();
  });

  it('collapses from the close button, and returns focus the same way', () => {
    render(<TopBarSearch />);

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('button', { name: content.search.close }));

    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveFocus();
  });

  it('submits the term to the inbox, keeping the scope it was searched from', () => {
    params = new URLSearchParams({ scope: 'all' });
    render(<TopBarSearch />);

    fireEvent.click(trigger());
    fireEvent.change(screen.getByRole('searchbox', { name: content.search.label }), {
      target: { value: '  fatima  ' },
    });
    fireEvent.submit(screen.getByRole('search'));

    expect(push).toHaveBeenCalledWith('/inbox?scope=all&q=fatima');
  });

  it('says the applied term on the collapsed trigger rather than hiding it', () => {
    params = new URLSearchParams({ q: 'fatima' });
    render(<TopBarSearch />);

    expect(
      screen.getByRole('button', { name: content.search.labelWithTerm('fatima') }),
    ).toHaveAttribute('aria-expanded', 'false');
  });
});
