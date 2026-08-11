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

  it('says an outbound message with no sender was sent automatically', () => {
    render(
      <MessageBubble message={{ ...BASE, direction: 'outbound', body: 'Hi!' }} senderName={null} />,
    );

    expect(screen.getByText(content.thread.sentByAutomation)).toBeInTheDocument();
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

  it('renders an image with its caption as the accessible name', () => {
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

    expect(screen.getByRole('img', { name: 'The error screen I get' })).toBeInTheDocument();
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
