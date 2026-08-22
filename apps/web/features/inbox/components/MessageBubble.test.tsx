import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MessageAttachment, MessageResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { MessageBubble } from './MessageBubble';

/**
 * TAR-20's third acceptance criterion: the thread renders text, image, document
 * and audio messages correctly, inbound and outbound.
 *
 * Also the two states an inbound attachment can be in before it is `stored`.
 * They are the reason the pipeline publishes `downloadState` at all, and a
 * silent gap for either would tell an agent the customer sent nothing.
 */

const BASE: MessageResponse = {
  id: '0192f006-0000-7000-8000-000000000601',
  conversationId: '0192f004-0000-7000-8000-000000000401',
  direction: 'inbound',
  type: 'text',
  status: 'delivered',
  body: null,
  attachments: [],
  sentByUserId: null,
  sentByAutomation: false,
  origin: 'contact',
  providerMessageId: null,
  failureReason: null,
  sentAt: '2026-08-10T08:05:00.000Z',
  createdAt: '2026-08-10T08:05:00.000Z',
};

function attachment(overrides: Partial<MessageAttachment>): MessageAttachment {
  return {
    id: '0192f007-0000-7000-8000-000000000701',
    providerMediaId: null,
    url: null,
    kind: 'image',
    downloadState: 'stored',
    mimeType: 'image/png',
    fileName: null,
    sizeBytes: null,
    ...overrides,
  };
}

describe('MessageBubble', () => {
  it('renders a text message and says which side it came from', () => {
    render(<MessageBubble message={{ ...BASE, body: 'Where is my invoice?' }} senderName={null} />);

    expect(screen.getByText('Where is my invoice?')).toBeInTheDocument();
    expect(screen.getByText(content.thread.inbound)).toBeInTheDocument();
  });

  it('names the agent who sent an outbound message, and its delivery status', () => {
    render(
      <MessageBubble
        message={{
          ...BASE,
          direction: 'outbound',
          status: 'read',
          body: 'On its way.',
          sentByUserId: '0192f001-0000-7000-8000-000000000101',
        }}
        senderName="Amina Haddad"
      />,
    );

    expect(screen.getByText(content.thread.sentBy('Amina Haddad'))).toBeInTheDocument();
    expect(screen.getByText(content.messageStatuses.read)).toBeInTheDocument();
  });

  it('names the chatbot rather than automation in general', () => {
    // `origin` is the narrower answer, and the only one that says *which* system
    // replied: a workflow (TAR-27) also sends with no sender, and an agent
    // deciding whether to take a thread over needs to know which it was.
    render(
      <MessageBubble
        message={{
          ...BASE,
          direction: 'outbound',
          body: 'Hi!',
          sentByAutomation: true,
          origin: 'bot',
        }}
        senderName={null}
      />,
    );

    expect(screen.getByText(content.thread.sentByBot)).toBeInTheDocument();
    expect(screen.queryByText(content.thread.sentByAutomation)).not.toBeInTheDocument();
  });

  it('says a non-chatbot automated send was sent automatically', () => {
    render(
      <MessageBubble
        message={{
          ...BASE,
          direction: 'outbound',
          body: 'Your ticket was closed.',
          sentByAutomation: true,
          origin: 'system',
        }}
        senderName={null}
      />,
    );

    expect(screen.getByText(content.thread.sentByAutomation)).toBeInTheDocument();
  });

  it('does not attribute a human’s reply to automation when their name is unresolved', () => {
    // The directory read is one page of users, so an agent past it resolves to
    // no name. Reading that as "a bot wrote this" misattributes a colleague's
    // words — `sentByAutomation` is the contract's answer and is asked first.
    render(
      <MessageBubble
        message={{
          ...BASE,
          direction: 'outbound',
          body: 'Looking into it now.',
          sentByUserId: '0192f001-0000-7000-8000-000000000199',
          sentByAutomation: false,
          origin: 'agent',
        }}
        senderName={null}
      />,
    );

    expect(screen.getByText(content.thread.sentByTeammate)).toBeInTheDocument();
    expect(screen.queryByText(content.thread.sentByAutomation)).not.toBeInTheDocument();
  });

  it('trusts the origin over a name that happens to resolve', () => {
    render(
      <MessageBubble
        message={{
          ...BASE,
          direction: 'outbound',
          body: 'Auto-reply.',
          sentByUserId: '0192f001-0000-7000-8000-000000000101',
          sentByAutomation: true,
          origin: 'bot',
        }}
        senderName="Amina Haddad"
      />,
    );

    expect(screen.getByText(content.thread.sentByBot)).toBeInTheDocument();
    expect(screen.queryByText(content.thread.sentBy('Amina Haddad'))).not.toBeInTheDocument();
  });

  it('reports a failed send with the provider’s reason, not just a colour', () => {
    render(
      <MessageBubble
        message={{
          ...BASE,
          direction: 'outbound',
          status: 'failed',
          body: 'Are you there?',
          failureReason: '131047 — outside the 24-hour window',
        }}
        senderName="Amina Haddad"
      />,
    );

    expect(screen.getByText(content.messageStatuses.failed)).toBeInTheDocument();
    expect(
      screen.getByText(content.thread.failureReason('131047 — outside the 24-hour window')),
    ).toBeInTheDocument();
  });

  it('does not repeat a visible caption as the image’s accessible name', () => {
    // The caption is rendered as a paragraph below the picture, so using it as
    // the alt made a screen reader read it twice — once as the image and once as
    // text. Saying what the picture *is* leaves the caption to be read once.
    render(
      <MessageBubble
        message={{
          ...BASE,
          type: 'image',
          body: 'The error screen I get',
          attachments: [attachment({ url: 'data:image/png;base64,iVBORw0KGgo=' })],
        }}
        senderName={null}
      />,
    );

    expect(screen.getByRole('img', { name: content.thread.imageFromCustomer })).toBeInTheDocument();
    expect(screen.getByText('The error screen I get')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'The error screen I get' })).toBeNull();
  });

  it('describes an uncaptioned image rather than leaving it nameless', () => {
    render(
      <MessageBubble
        message={{
          ...BASE,
          type: 'image',
          attachments: [attachment({ url: 'data:image/png;base64,iVBORw0KGgo=' })],
        }}
        senderName={null}
      />,
    );

    expect(screen.getByRole('img', { name: content.thread.imageFromCustomer })).toBeInTheDocument();
  });

  it('renders a document as a named link with its size', () => {
    render(
      <MessageBubble
        message={{
          ...BASE,
          direction: 'outbound',
          type: 'document',
          attachments: [
            attachment({
              kind: 'document',
              mimeType: 'application/pdf',
              url: 'https://api.example.test/api/v1/media/1/content',
              fileName: 'statement.pdf',
              sizeBytes: 2_048,
            }),
          ],
        }}
        senderName="Amina Haddad"
      />,
    );

    const link = screen.getByRole('link', { name: content.thread.openDocument('statement.pdf') });

    expect(link).toHaveAttribute('href', 'https://api.example.test/api/v1/media/1/content');
    // Opens in a new tab, so it must not hand the opener to another origin.
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(
      screen.getByText(content.thread.fileSize('2', content.fileSizeUnits.kb)),
    ).toBeInTheDocument();
  });

  it('renders an audio attachment as a player with controls and no autoplay', () => {
    const { container } = render(
      <MessageBubble
        message={{
          ...BASE,
          type: 'audio',
          attachments: [
            attachment({
              kind: 'audio',
              mimeType: 'audio/ogg',
              url: 'data:audio/wav;base64,UklGRg==',
            }),
          ],
        }}
        senderName={null}
      />,
    );

    const player = container.querySelector('audio');

    expect(player).not.toBeNull();
    expect(player).toHaveAttribute('controls');
    expect(player).not.toHaveAttribute('autoplay');
  });

  it('says an attachment is still downloading rather than showing an empty box', () => {
    render(
      <MessageBubble
        message={{
          ...BASE,
          type: 'image',
          attachments: [attachment({ downloadState: 'pending' })],
        }}
        senderName={null}
      />,
    );

    expect(screen.getByText(content.thread.attachmentDownloading)).toBeInTheDocument();
  });

  it('reserves a player, not a photo, for a voice note that is still downloading', () => {
    // One 4:3 box for every kind produced exactly the layout shift the reserved
    // box exists to prevent: a pending audio collapsed to a thin player when it
    // landed.
    const { container } = render(
      <MessageBubble
        message={{
          ...BASE,
          type: 'audio',
          attachments: [attachment({ kind: 'audio', downloadState: 'pending' })],
        }}
        senderName={null}
      />,
    );

    expect(screen.getByText(content.thread.attachmentDownloading)).toBeInTheDocument();
    expect(container.querySelector('[class*="audioPlaceholder"]')).not.toBeNull();
    expect(container.querySelector('[class*="frame"]')).toBeNull();
  });

  it('reserves a link row for a document that is still downloading', () => {
    const { container } = render(
      <MessageBubble
        message={{
          ...BASE,
          type: 'document',
          attachments: [attachment({ kind: 'document', downloadState: 'pending' })],
        }}
        senderName={null}
      />,
    );

    expect(container.querySelector('[class*="document"]')).not.toBeNull();
    expect(container.querySelector('[class*="frame"]')).toBeNull();
  });

  it('says an attachment failed rather than leaving a gap where it was', () => {
    render(
      <MessageBubble
        message={{
          ...BASE,
          type: 'document',
          attachments: [attachment({ kind: 'document', downloadState: 'failed' })],
        }}
        senderName={null}
      />,
    );

    expect(screen.getByText(content.thread.attachmentFailed)).toBeInTheDocument();
  });

  it('labels a message type it cannot render instead of dropping the row', () => {
    render(<MessageBubble message={{ ...BASE, type: 'location' }} senderName={null} />);

    expect(screen.getByText(content.messageTypes.location)).toBeInTheDocument();
    expect(screen.getByText(content.thread.unrenderableBody)).toBeInTheDocument();
  });
});
