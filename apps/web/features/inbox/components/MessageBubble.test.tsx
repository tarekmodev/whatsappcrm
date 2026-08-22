import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MessageAttachment, MessageResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { MessageBubble } from './MessageBubble';

/**
 * TAR-20's third acceptance criterion: the thread renders text, image, document
 * and audio messages correctly, inbound and outbound.
 *
 * Also the two states an inbound attachment can be in before it is `stored`.
 * They are the reason the pipeline publishes `downloadState` at all, and a
 * silent gap for either would tell an agent the customer sent nothing.
 *
 * Who sent a message and when is the *run's* since TAR-518 — see
 * `MessageRun.test.tsx`. What is still per-message, and tested here, is the
 * content and whether that message reached the customer.
 */

const sendMessageAction = vi.fn();

vi.mock('@/features/inbox/composer.actions', () => ({
  sendMessageAction: (...args: unknown[]) => sendMessageAction(...args) as unknown,
}));

const CONTACT = 'Fatima Al-Zahra';

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

function renderBubble(message: MessageResponse) {
  return render(
    <ToastProvider>
      <MessageBubble message={message} contactName={CONTACT} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  sendMessageAction.mockReset();
  sendMessageAction.mockResolvedValue({ status: 'success', data: undefined });
});

describe('MessageBubble', () => {
  it('renders a text message', () => {
    renderBubble({ ...BASE, body: 'Where is my invoice?' });

    expect(screen.getByText('Where is my invoice?')).toBeInTheDocument();
  });

  it('labels a message type it cannot render instead of dropping the row', () => {
    renderBubble({ ...BASE, type: 'location' });

    expect(screen.getByText(content.messageTypes.location)).toBeInTheDocument();
    expect(screen.getByText(content.thread.unrenderableBody)).toBeInTheDocument();
  });

  it('does not repeat a visible caption as the image’s accessible name', () => {
    // The caption is rendered as a paragraph below the picture, so using it as
    // the alt made a screen reader read it twice — once as the image and once as
    // text. Saying what the picture *is* leaves the caption to be read once.
    renderBubble({
      ...BASE,
      type: 'image',
      body: 'The error screen I get',
      attachments: [attachment({ url: 'data:image/png;base64,iVBORw0KGgo=' })],
    });

    expect(screen.getByRole('img', { name: content.thread.imageFromCustomer })).toBeInTheDocument();
    expect(screen.getByText('The error screen I get')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'The error screen I get' })).toBeNull();
  });

  it('describes an uncaptioned image rather than leaving it nameless', () => {
    renderBubble({
      ...BASE,
      type: 'image',
      attachments: [attachment({ url: 'data:image/png;base64,iVBORw0KGgo=' })],
    });

    expect(screen.getByRole('img', { name: content.thread.imageFromCustomer })).toBeInTheDocument();
  });

  it('renders a document as a named link with its size', () => {
    renderBubble({
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
    });

    const link = screen.getByRole('link', { name: content.thread.openDocument('statement.pdf') });

    expect(link).toHaveAttribute('href', 'https://api.example.test/api/v1/media/1/content');
    // Opens in a new tab, so it must not hand the opener to another origin.
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(
      screen.getByText(content.thread.fileSize('2', content.fileSizeUnits.kb)),
    ).toBeInTheDocument();
  });

  it('renders an audio attachment as a player with controls and no autoplay', () => {
    const { container } = renderBubble({
      ...BASE,
      type: 'audio',
      attachments: [
        attachment({ kind: 'audio', mimeType: 'audio/ogg', url: 'data:audio/wav;base64,UklGRg==' }),
      ],
    });

    const player = container.querySelector('audio');

    expect(player).not.toBeNull();
    expect(player).toHaveAttribute('controls');
    expect(player).not.toHaveAttribute('autoplay');
  });

  it('says an attachment is still downloading rather than showing an empty box', () => {
    renderBubble({
      ...BASE,
      type: 'image',
      attachments: [attachment({ downloadState: 'pending' })],
    });

    expect(screen.getByText(content.thread.attachmentDownloading)).toBeInTheDocument();
  });

  it('reserves a player, not a photo, for a voice note that is still downloading', () => {
    // One 4:3 box for every kind produced exactly the layout shift the reserved
    // box exists to prevent: a pending audio collapsed to a thin player when it
    // landed.
    const { container } = renderBubble({
      ...BASE,
      type: 'audio',
      attachments: [attachment({ kind: 'audio', downloadState: 'pending' })],
    });

    expect(screen.getByText(content.thread.attachmentDownloading)).toBeInTheDocument();
    expect(container.querySelector('[class*="audioPlaceholder"]')).not.toBeNull();
    expect(container.querySelector('[class*="frame"]')).toBeNull();
  });

  it('reserves a link row for a document that is still downloading', () => {
    const { container } = renderBubble({
      ...BASE,
      type: 'document',
      attachments: [attachment({ kind: 'document', downloadState: 'pending' })],
    });

    expect(container.querySelector('[class*="document"]')).not.toBeNull();
    expect(container.querySelector('[class*="frame"]')).toBeNull();
  });

  it('says an attachment failed rather than leaving a gap where it was', () => {
    renderBubble({
      ...BASE,
      type: 'document',
      attachments: [attachment({ kind: 'document', downloadState: 'failed' })],
    });

    expect(screen.getByText(content.thread.attachmentFailed)).toBeInTheDocument();
  });
});

/**
 * TAR-518: the delivery state has been on `MessageResponse` since TAR-20 and was
 * rendered as a bare word. These are the treatment it was missing — and the
 * acceptance criterion that a failed send is reported *on the message*, with a
 * way out, rather than only in a toast that is gone in seconds.
 */
describe('MessageBubble — delivery state', () => {
  it('reports an outbound message’s delivery state in words, not only as a glyph', () => {
    renderBubble({ ...BASE, direction: 'outbound', status: 'read', body: 'On its way.' });

    expect(screen.getByText(content.messageStatuses.read)).toBeInTheDocument();
  });

  it('shows no delivery state on the customer’s own message', () => {
    // Inbound messages are born `delivered` (the contract says so). A tick on
    // the customer's words would claim we delivered something to ourselves.
    renderBubble({ ...BASE, body: 'Hello?' });

    expect(screen.queryByText(content.messageStatuses.delivered)).toBeNull();
  });

  it('reports a failed send with the provider’s reason, not just a colour', () => {
    renderBubble({
      ...BASE,
      direction: 'outbound',
      status: 'failed',
      body: 'Are you there?',
      failureReason: '131047 — outside the 24-hour window',
    });

    expect(screen.getByText(content.messageStatuses.failed)).toBeInTheDocument();
    expect(
      screen.getByText(content.thread.failureReason('131047 — outside the 24-hour window')),
    ).toBeInTheDocument();
  });

  it('offers a retry on the failed message itself, and sends the same text', async () => {
    renderBubble({
      ...BASE,
      direction: 'outbound',
      status: 'failed',
      body: 'Are you there?',
    });

    fireEvent.click(screen.getByRole('button', { name: content.thread.retrySendAria(CONTACT) }));

    await waitFor(() => {
      expect(sendMessageAction).toHaveBeenCalledWith(BASE.conversationId, expect.any(String), {
        type: 'text',
        body: 'Are you there?',
      });
    });
  });

  it('says how to re-send a failed photo rather than offering to send its caption', () => {
    // A send names the *upload's* id, which a delivered attachment does not
    // publish — so a retry here would quietly send the words without the
    // picture, and the agent would believe the customer had the file.
    renderBubble({
      ...BASE,
      direction: 'outbound',
      type: 'image',
      status: 'failed',
      body: 'Here is the receipt',
      attachments: [attachment({ url: 'data:image/png;base64,iVBORw0KGgo=' })],
    });

    expect(screen.getByText(content.thread.retryUnavailable)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: content.thread.retrySendAria(CONTACT) }),
    ).toBeNull();
  });
});
