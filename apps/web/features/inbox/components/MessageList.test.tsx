import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MessageResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { MessageList } from './MessageList';

const CONTACT = 'Fatima Al-Zahra';

function message(id: string, body: string, sentAt: string): MessageResponse {
  return {
    id,
    conversationId: '0192f004-0000-7000-8000-000000000401',
    direction: 'inbound',
    type: 'text',
    status: 'delivered',
    body,
    attachments: [],
    sentByUserId: null,
    sentByAutomation: false,
    origin: 'contact',
    providerMessageId: null,
    failureReason: null,
    sentAt,
    createdAt: sentAt,
  };
}

function list(messages: readonly MessageResponse[]) {
  return (
    <ToastProvider>
      <MessageList
        messages={messages}
        contactName={CONTACT}
        senderNames={new Map()}
        hasOlderMessages={false}
      />
    </ToastProvider>
  );
}

/**
 * The empty branch is the one thread-column state that does not go through
 * `.state`, and it used to be returned bare: a flex item in a row-direction,
 * stretch-aligned parent, which draws it as a dashed sliver running the full
 * height of the column. The wrapper is what makes it read like the other two.
 */
describe('MessageList', () => {
  it('explains an empty conversation rather than leaving a blank stream', () => {
    render(
      <MessageList
        messages={[]}
        contactName="Fatima Al-Zahra"
        senderNames={new Map()}
        hasOlderMessages={false}
      />,
    );

    expect(screen.getByText(content.thread.emptyHeading)).toBeInTheDocument();
  });

  it('wraps the empty state, so it is centred in the stream instead of stretched down it', () => {
    render(
      <MessageList
        messages={[]}
        contactName="Fatima Al-Zahra"
        senderNames={new Map()}
        hasOlderMessages={false}
      />,
    );

    const heading = screen.getByText(content.thread.emptyHeading);
    // EmptyState's own box, then the wrapper this component adds around it.
    const wrapper = heading.parentElement?.parentElement;

    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toMatch(/emptyState/);
  });
});

/**
 * TAR-518's sixth acceptance criterion: a screen reader hears an arriving
 * message **once**, and hears who sent it.
 *
 * The stream is a `log` landmark whose own live behaviour is off, and the
 * announcement is a separate polite region carrying one sentence — because React
 * re-renders the whole list on every refetch, and a live `<ol>` announces
 * whatever moved, which on a thread grouped into runs is the last run entire.
 */
describe('MessageList — announcing an arrival', () => {
  it('says nothing when the thread first loads', () => {
    // A conversation being opened is a page load, not a message coming in.
    render(list([message('a', 'Hello', '2026-08-10T08:05:00.000Z')]));

    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('names the sender and reads the message when one arrives', () => {
    const { rerender } = render(list([message('a', 'Hello', '2026-08-10T08:05:00.000Z')]));

    rerender(
      list([
        message('a', 'Hello', '2026-08-10T08:05:00.000Z'),
        message('b', 'Are you there?', '2026-08-10T08:30:00.000Z'),
      ]),
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      content.thread.messageArrived(CONTACT, 'Are you there?'),
    );
  });

  it('announces the kind of a message that has no words in it', () => {
    // A photo or a location would otherwise be "Fatima Al-Zahra:" followed by
    // silence, which tells a screen-reader user that nothing arrived.
    const { rerender } = render(list([message('a', 'Hello', '2026-08-10T08:05:00.000Z')]));

    rerender(
      list([
        message('a', 'Hello', '2026-08-10T08:05:00.000Z'),
        { ...message('b', '', '2026-08-10T08:30:00.000Z'), type: 'image', body: null },
      ]),
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      content.thread.messageArrived(CONTACT, content.messageTypes.image),
    );
  });

  it('carries the stream as a log landmark with its own live behaviour off', () => {
    render(list([message('a', 'Hello', '2026-08-10T08:05:00.000Z')]));

    const log = screen.getByRole('log', { name: content.thread.messagesHeading });

    expect(log).toHaveAttribute('aria-live', 'off');
    // Scrollable, so a keyboard user can reach and read it.
    expect(log).toHaveAttribute('tabindex', '0');
  });
});
