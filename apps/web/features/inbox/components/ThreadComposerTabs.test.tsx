import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThreadComposerTabs } from './ThreadComposerTabs';

/**
 * The single most consequential control in this product: where what you type
 * goes. A note that reached a customer would be the worst bug it could have, so
 * these cases pin that the destination is one deliberate, announced choice.
 */
describe('ThreadComposerTabs', () => {
  function renderTabs() {
    render(
      <ThreadComposerTabs
        reply={<textarea aria-label="Write a message" />}
        note={<textarea aria-label="Write a note" />}
      />,
    );
  }

  it('opens on the customer-facing reply', () => {
    renderTabs();

    expect(screen.getByRole('tab', { name: /reply on whatsapp/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('textbox', { name: 'Write a message' })).toBeInTheDocument();
  });

  it('offers exactly one composer at a time', () => {
    // Both panels stay mounted so a half-written reply survives a glance at the
    // notes — `hidden` is what keeps the inactive one out of the accessibility
    // tree, so nothing ever offers two boxes at once.
    renderTabs();

    // Queried by role, which is the accessibility tree — a `hidden` panel is
    // still in the DOM, and that is exactly the distinction being pinned here.
    expect(screen.queryByRole('textbox', { name: 'Write a note' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Write a note')).not.toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: 'Comment' }));

    expect(screen.getByRole('textbox', { name: 'Write a note' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Write a message' })).not.toBeInTheDocument();
  });

  it('is one tab stop, moved through with the arrow keys', () => {
    renderTabs();

    const reply = screen.getByRole('tab', { name: /reply on whatsapp/i });
    const comment = screen.getByRole('tab', { name: 'Comment' });

    expect(reply).toHaveAttribute('tabindex', '0');
    expect(comment).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(reply, { key: 'ArrowRight' });

    expect(comment).toHaveAttribute('aria-selected', 'true');
    expect(comment).toHaveFocus();

    // And it wraps, so the strip cannot be walked into a dead end.
    fireEvent.keyDown(comment, { key: 'ArrowRight' });
    expect(reply).toHaveAttribute('aria-selected', 'true');
  });

  it('points each tab at the panel it controls', () => {
    renderTabs();

    const reply = screen.getByRole('tab', { name: /reply on whatsapp/i });
    const panelId = reply.getAttribute('aria-controls') ?? '';

    expect(document.getElementById(panelId)).toHaveAttribute('role', 'tabpanel');
  });
});
