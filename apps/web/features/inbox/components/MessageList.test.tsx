import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { content } from '@/content/en';
import { MessageList } from './MessageList';

/**
 * The empty branch is the one thread-column state that does not go through
 * `.state`, and it used to be returned bare: a flex item in a row-direction,
 * stretch-aligned parent, which draws it as a dashed sliver running the full
 * height of the column. The wrapper is what makes it read like the other two.
 */
describe('MessageList', () => {
  it('explains an empty conversation rather than leaving a blank stream', () => {
    render(<MessageList messages={[]} senderNames={new Map()} hasOlderMessages={false} />);

    expect(screen.getByText(content.thread.emptyHeading)).toBeInTheDocument();
  });

  it('wraps the empty state, so it is centred in the stream instead of stretched down it', () => {
    render(<MessageList messages={[]} senderNames={new Map()} hasOlderMessages={false} />);

    const heading = screen.getByText(content.thread.emptyHeading);
    // EmptyState's own box, then the wrapper this component adds around it.
    const wrapper = heading.parentElement?.parentElement;

    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toMatch(/emptyState/);
  });
});
