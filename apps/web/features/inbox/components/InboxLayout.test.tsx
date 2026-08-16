import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { content } from '@/content/en';
import { InboxLayout } from './InboxLayout';

/**
 * The replacement accessibility contract, and the reason the `SectionCard`s
 * could be dropped at all.
 *
 * Before TAR-513 each region was a card whose heading named it. The cards are
 * gone — a workspace is not four cards on a canvas — so the name lives on the
 * region, and the ids the cards carried live there too. Both are invisible: a
 * later edit can drop either without anything on screen changing, and what
 * breaks is a screen-reader user's only way to jump between the four regions.
 */
function renderLayout(hasThread: boolean) {
  render(
    <InboxLayout
      hasThread={hasThread}
      filters={<nav aria-label={content.inbox.filtersLabel} />}
      list={<p>List</p>}
      thread={<p>Thread</p>}
      context={<p>Context</p>}
    />,
  );
}

describe('InboxLayout', () => {
  it('names every region, so the four are reachable without tabbing the list', () => {
    renderLayout(true);

    expect(
      screen.getByRole('navigation', { name: content.inbox.filtersLabel }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: content.inbox.conversationsHeading }),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: content.inbox.threadHeading })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: content.inbox.contextToggle })).toBeInTheDocument();
  });

  it('keeps the ids the dropped cards carried, so nothing linking here breaks', () => {
    renderLayout(true);

    expect(
      screen.getByRole('region', { name: content.inbox.conversationsHeading }),
    ).toHaveAttribute('id', 'conversations');
    expect(screen.getByRole('region', { name: content.inbox.threadHeading })).toHaveAttribute(
      'id',
      'conversation',
    );
  });

  it('gives the context panel a tab stop, because it scrolls and may hold nothing focusable', () => {
    renderLayout(true);

    expect(screen.getByRole('region', { name: content.inbox.contextToggle })).toHaveAttribute(
      'tabindex',
      '0',
    );
  });

  it('renders no context region without an open thread — there is nothing for it to describe', () => {
    renderLayout(false);

    expect(screen.queryByRole('region', { name: content.inbox.contextToggle })).toBeNull();
  });

  it('keeps both panes in the markup, so a deep link and the way back are one render apart', () => {
    renderLayout(true);

    expect(screen.getByText('List')).toBeInTheDocument();
    expect(screen.getByText('Thread')).toBeInTheDocument();
  });
});
